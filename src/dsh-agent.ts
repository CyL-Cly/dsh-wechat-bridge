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
export class DshAgent {
  private harness: HarnessLike | null = null

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

    const result = await this.harness.run(prompt, { sessionId })
    const text = (result.finalResponse ?? '').trim() || '（dsh 返回空内容）'
    return { sessionId: result.sessionId || sessionId, text }
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
  }
}
