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

/** One SDK session handle (resumeSession / session().run). */
type HarnessSessionLike = {
  id: string
  run: (
    input: string,
  ) => Promise<{ sessionId: string; finalResponse: string }>
}

/**
 * Structural shape of DeepSeekHarness from @deepseek-ai/dsh-sdk-client.
 * Newer clients expose resumeSession; older ones only have client.request.
 */
type HarnessLike = {
  start: () => Promise<void>
  close: () => Promise<void>
  session: (sessionId?: string) => HarnessSessionLike
  resumeSession?: (sessionId: string) => Promise<HarnessSessionLike>
  run: (
    input: string,
    opts?: { sessionId?: string },
  ) => Promise<{ sessionId: string; finalResponse: string }>
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
 *
 * Session pattern matches DeepSeekHarness IM/SDK usage and cc-haha adapters:
 * keep one process-wide harness, persist chat→session ids, reuse the same
 * HarnessSession handle for follow-ups, resume from disk after restart,
 * never resume+create the same id (that double-opens the write handle).
 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Persistence create race / identity already on disk. */
function isSessionAlreadyExists(err: unknown): boolean {
  return /session .+ already exists/i.test(errText(err))
}

/** SDK child already has this id open (in-process). */
function isSessionAlreadyOpen(err: unknown): boolean {
  return /already open or opening/i.test(errText(err))
}

/** Write handle held — usually another process (e.g. dsh-web) or a stale open. */
function isSessionAlreadyOwned(err: unknown): boolean {
  return /already owned by an active write handle/i.test(errText(err))
}

function isResumeMissingOrUnreadable(err: unknown): boolean {
  const t = errText(err)
  // Missing / unreadable / incompatible — fall through to lazy create.
  return /not found|no such|missing|does not exist|unreadable|incompatible|unknown session|ENOENT|no session|cannot resume|failed to (open|load|read)/i.test(
    t,
  )
}

export class DshAgent {
  private harness: HarnessLike | null = null
  /** Live HarnessSession handles opened in THIS process — reuse, do not resume again. */
  private readonly sessions = new Map<string, HarnessSessionLike>()
  /** In-flight open promises so parallel first messages share one resume/create. */
  private readonly opening = new Map<string, Promise<HarnessSessionLike>>()

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
   * resumeSession when available; else low-level session/resume + session(id).
   * Never pair this with harness.run({sessionId}) create — that re-opens the write handle.
   */
  private async resumeFromDisk(sessionId: string): Promise<HarnessSessionLike> {
    const harness = this.harness
    if (!harness) throw new Error('dsh harness not started')
    if (typeof harness.resumeSession === 'function') {
      return harness.resumeSession(sessionId)
    }
    await harness.start()
    await harness.client.request('session/resume', { sessionId })
    return harness.session(sessionId)
  }

  private lazyCreate(sessionId: string): HarnessSessionLike {
    if (!this.harness) throw new Error('dsh harness not started')
    return this.harness.session(sessionId)
  }

  /**
   * Obtain a session handle for this wx_ id:
   * 1. Reuse in-process map (IM live reconnect).
   * 2. Prefer resumeSession for persisted ids after bridge restart.
   * 3. If already open in our sdk child → session(id) only.
   * 4. If missing/unreadable → lazy session(id) create on first prompt.
   * 5. If owned by another process → one short backoff retry, then clear error.
   */
  private async getSession(sessionId: string): Promise<HarnessSessionLike> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const inflight = this.opening.get(sessionId)
    if (inflight) return inflight

    const task = this.openSession(sessionId)
    this.opening.set(sessionId, task)
    try {
      const session = await task
      this.sessions.set(sessionId, session)
      return session
    } finally {
      this.opening.delete(sessionId)
    }
  }

  private async openSession(sessionId: string): Promise<HarnessSessionLike> {
    try {
      const session = await this.resumeFromDisk(sessionId)
      console.log(`[dsh-agent] resumed session=${sessionId}`)
      return session
    } catch (err) {
      if (isSessionAlreadyOpen(err)) {
        console.log(`[dsh-agent] already open in sdk child session=${sessionId}, reuse handle`)
        return this.lazyCreate(sessionId)
      }

      if (isSessionAlreadyOwned(err)) {
        // Another process (often dsh-web) may hold the write lease briefly.
        console.log(
          `[dsh-agent] write handle owned session=${sessionId}, brief backoff then retry resume once`,
        )
        await new Promise((r) => setTimeout(r, 400))
        try {
          const session = await this.resumeFromDisk(sessionId)
          console.log(`[dsh-agent] resumed after backoff session=${sessionId}`)
          return session
        } catch (retryErr) {
          if (isSessionAlreadyOpen(retryErr)) {
            return this.lazyCreate(sessionId)
          }
          if (isSessionAlreadyOwned(retryErr)) {
            throw new Error(
              `session ${sessionId} 正被其他进程占用（例如 dsh-web 打开了同一会话）。请关闭 Web UI 中该会话后重试。`,
            )
          }
          // Missing after backoff → create path below
          if (!isResumeMissingOrUnreadable(retryErr) && !isSessionAlreadyExists(retryErr)) {
            throw retryErr
          }
          console.log(
            `[dsh-agent] resume still unavailable session=${sessionId}: ${errText(retryErr).slice(0, 160)}`,
          )
        }
      } else if (isSessionAlreadyExists(err)) {
        // Disk identity exists but resume path said exists — attach lazy handle; first
        // prompt recover path will resume if create races.
        console.log(`[dsh-agent] session exists on disk session=${sessionId}, attaching handle`)
        return this.lazyCreate(sessionId)
      } else if (isResumeMissingOrUnreadable(err)) {
        console.log(
          `[dsh-agent] resume miss session=${sessionId}: ${errText(err).slice(0, 160)}; lazy create`,
        )
        return this.lazyCreate(sessionId)
      } else {
        throw err
      }

      return this.lazyCreate(sessionId)
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

    const session = await this.getSession(sessionId)

    try {
      const result = await session.run(prompt)
      const text = (result.finalResponse ?? '').trim() || '（dsh 返回空内容）'
      return { sessionId: result.sessionId || sessionId, text }
    } catch (err) {
      // First prompt on a lazy handle can race a disk identity: drop map entry
      // and resume once, then run again — never resume while already running create.
      if (isSessionAlreadyExists(err) || isSessionAlreadyOwned(err)) {
        console.log(
          `[dsh-agent] prompt hit ${isSessionAlreadyOwned(err) ? 'owned' : 'exists'} session=${sessionId}, recover via resume`,
        )
        this.sessions.delete(sessionId)
        let recovered: HarnessSessionLike
        try {
          recovered = await this.resumeFromDisk(sessionId)
        } catch (resumeErr) {
          if (isSessionAlreadyOpen(resumeErr)) {
            recovered = this.lazyCreate(sessionId)
          } else if (isSessionAlreadyOwned(resumeErr)) {
            throw new Error(
              `session ${sessionId} 正被其他进程占用（例如 dsh-web 打开了同一会话）。请关闭 Web UI 中该会话后重试。`,
            )
          } else {
            throw resumeErr
          }
        }
        this.sessions.set(sessionId, recovered)
        const result = await recovered.run(prompt)
        const text = (result.finalResponse ?? '').trim() || '（dsh 返回空内容）'
        return { sessionId: result.sessionId || sessionId, text }
      }
      throw err
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
    this.sessions.clear()
    this.opening.clear()
    if (this.harness) {
      await this.harness.close()
      this.harness = null
    }
  }
}
