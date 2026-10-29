import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { BridgeConfig } from './config.js'
import type { InboundTextMessage } from './types.js'
import { sessionIdFor } from './session-map.js'

export interface AgentReply {
  sessionId: string
  text: string
}

type HarnessLike = {
  run: (
    input: string,
    opts?: { sessionId?: string },
  ) => Promise<{ sessionId: string; finalResponse: string }>
  close: () => Promise<void>
  start: () => Promise<void>
  client: {
    request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }
}

interface ModelRoute {
  provider: string
  model: string
}

/**
 * Read provider/model from a dsh profile's cordis.patch.yml (agent-default-model).
 * Bridge does not call DeepSeek HTTP or invent model ids — local dsh config does.
 */
export function readAgentDefaultModel(patchPath: string): ModelRoute | null {
  if (!existsSync(patchPath)) return null
  const text = readFileSync(patchPath, 'utf8')
  const block = text.match(/id:\s*agent-default-model[\s\S]*?(?=\n-\s*id:|\n*$)/)
  if (!block) return null
  const provider = block[0].match(/\bprovider:\s*([^\s#]+)/)?.[1]
  const model = block[0].match(/\bmodel:\s*([^\s#]+)/)?.[1]
  if (!provider || !model) return null
  return { provider, model }
}

/** Resolve model route from shared DSH_HOME profiles; env pair is escape hatch only. */
export function resolveModelRoute(dshHome: string, cfg: BridgeConfig): ModelRoute {
  for (const name of ['web', cfg.dshProfile, 'sdk'].filter(Boolean)) {
    const hit = readAgentDefaultModel(join(dshHome, 'profiles', name, 'cordis.patch.yml'))
    if (hit) return hit
  }
  if (cfg.dshProvider && cfg.dshModel) {
    return { provider: cfg.dshProvider, model: cfg.dshModel }
  }
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

function sdkClientIsModern(): boolean {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req('@deepseek-ai/dsh-sdk-client/package.json') as { version?: string }
    const ver = pkg.version ?? ''
    // 0.0.1-rc.1 is launch-shaped; newer source builds accept profile/dshHome.
    return Boolean(ver) && !ver.startsWith('0.0.1')
  } catch {
    return false
  }
}

/**
 * Hand WeChat turns to a local `dsh --profile sdk` subprocess that shares the
 * same DSH_HOME as `dsh web`, so sessions show up in the Web UI.
 * The bridge never POSTs to DeepSeek chat/completions itself.
 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isSessionAlreadyExists(err: unknown): boolean {
  return /session .+ already exists/i.test(errText(err))
}

export class DshAgent {
  private harness: HarnessLike | null = null
  /** Sessions opened (created or resumed) in this process — skip resume next time. */
  private readonly liveSessions = new Set<string>()

  constructor(private readonly cfg: BridgeConfig) {}

  async ensureStarted(): Promise<void> {
    if (this.cfg.agentMode === 'echo') return
    if (this.harness) return

    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const dshHome = this.cfg.dshHome
    const dshBin = this.cfg.dshBin || 'dsh'
    const profile = this.cfg.dshProfile || 'sdk'
    const route = resolveModelRoute(dshHome, this.cfg)
    const cwd = this.cfg.agentCwd

    console.log(
      `[dsh-agent] handoff -> local dsh profile=${profile} home=${dshHome} route=${route.provider}/${route.model}`,
    )

    const options = sdkClientIsModern()
      ? {
          profile,
          dshBin,
          dshHome,
          cwd,
          processCwd: cwd,
          provider: route.provider,
          model: route.model,
          initializeTimeoutMs: 120_000,
        }
      : {
          launch: {
            command: dshBin,
            args: ['--profile', profile],
            cwd,
            // Inherit credentials/env from the host; only pin DSH_HOME.
            env: { ...process.env, DSH_HOME: dshHome },
          },
          cwd,
          provider: route.provider,
          model: route.model,
        }

    this.harness = new DeepSeekHarness(options as never) as unknown as HarnessLike
  }

  /**
   * After bridge restart the dsh child is new; session/prompt always create()s
   * when the id is not in memory, which throws if the id already lives on disk.
   * Prefer session/resume first for known ids, then prompt.
   */
  private async ensureSessionReady(sessionId: string): Promise<void> {
    if (!this.harness || this.liveSessions.has(sessionId)) return
    try {
      await this.harness.start()
      await this.harness.client.request('session/resume', { sessionId })
      this.liveSessions.add(sessionId)
      console.log(`[dsh-agent] resumed session=${sessionId}`)
    } catch (err) {
      // Missing / unreadable session → leave to session/prompt create path.
      console.log(`[dsh-agent] resume skip session=${sessionId}: ${errText(err).slice(0, 160)}`)
    }
  }

  async reply(msg: InboundTextMessage): Promise<AgentReply> {
    const sessionId = sessionIdFor(msg, this.cfg.sessionScope)
    const prompt = this.buildPrompt(msg)

    if (this.cfg.agentMode === 'echo') {
      return {
        sessionId,
        text: `[dsh-wechat-bridge/echo] ${prompt}`,
      }
    }

    await this.ensureStarted()
    if (!this.harness) throw new Error('dsh harness not started')

    await this.ensureSessionReady(sessionId)

    try {
      const result = await this.harness.run(prompt, { sessionId })
      this.liveSessions.add(sessionId)
      const text = (result.finalResponse ?? '').trim() || '（dsh 返回空内容）'
      return { sessionId: result.sessionId || sessionId, text }
    } catch (err) {
      if (!isSessionAlreadyExists(err)) throw err
      console.log(`[dsh-agent] create raced existing session=${sessionId}, resume+retry`)
      await this.harness.client.request('session/resume', { sessionId })
      this.liveSessions.add(sessionId)
      const result = await this.harness.run(prompt, { sessionId })
      const text = (result.finalResponse ?? '').trim() || '（dsh 返回空内容）'
      return { sessionId: result.sessionId || sessionId, text }
    }
  }

  private buildPrompt(msg: InboundTextMessage): string {
    const meta = [
      `channel=wechat`,
      `robot=${msg.robotCode || '-'}`,
      `chat=${msg.fromWxid}`,
      `sender=${msg.senderWxid}`,
      `is_group=${msg.isChatRoom}`,
    ].join(' ')
    return `[wechat ${meta}]\n${msg.text}`
  }

  async close(): Promise<void> {
    if (this.harness) {
      await this.harness.close()
      this.harness = null
    }
    this.liveSessions.clear()
  }
}
