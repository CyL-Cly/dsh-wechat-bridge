import { config as loadDotenv } from 'dotenv'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

loadDotenv()

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function list(name: string): string[] {
  const raw = process.env[name]
  if (!raw?.trim()) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export type AgentMode = 'sdk' | 'echo'

export interface BridgeConfig {
  host: string
  port: number
  /** Required shared secret for webhook/API (BRIDGE_WEBHOOK_SECRET or ACCESS_TOKEN). */
  accessToken: string
  wechatClientBaseUrl: string
  wechatClientApiToken: string
  aiTrigger: string
  ignoreSelf: boolean
  textOnly: boolean
  agentMode: AgentMode
  dshBin: string
  dshHome: string
  dshProfile: string
  dshProvider: string
  dshModel: string
  deepseekApiKey: string
  dshPatches: string[]
  sessionScope: 'chat' | 'chat_sender'
}

/** Resolve token: BRIDGE_WEBHOOK_SECRET > ACCESS_TOKEN. Empty → generate & persist. */
export function resolveAccessToken(cwd = process.cwd()): string {
  const fromEnv =
    (process.env.BRIDGE_WEBHOOK_SECRET ?? '').trim() ||
    (process.env.ACCESS_TOKEN ?? '').trim()
  if (fromEnv) return fromEnv

  const token = randomBytes(32).toString('hex')
  const envPath = resolve(cwd, '.env')
  const line = `BRIDGE_WEBHOOK_SECRET=${token}\n`
  try {
    if (existsSync(envPath)) {
      const cur = readFileSync(envPath, 'utf8')
      if (/^BRIDGE_WEBHOOK_SECRET=/m.test(cur)) {
        writeFileSync(
          envPath,
          cur.replace(/^BRIDGE_WEBHOOK_SECRET=.*$/m, `BRIDGE_WEBHOOK_SECRET=${token}`),
          'utf8',
        )
      } else if (/^ACCESS_TOKEN=/m.test(cur)) {
        writeFileSync(
          envPath,
          cur.replace(/^ACCESS_TOKEN=.*$/m, `ACCESS_TOKEN=${token}`),
          'utf8',
        )
      } else {
        appendFileSync(envPath, `\n# auto-generated — required webhook auth\n${line}`, 'utf8')
      }
    } else {
      writeFileSync(envPath, `# auto-generated — required webhook auth\n${line}`, 'utf8')
    }
  } catch (err) {
    console.error('[dsh-wechat-bridge] failed to persist generated token to .env:', err)
  }
  process.env.BRIDGE_WEBHOOK_SECRET = token
  console.warn(
    '[dsh-wechat-bridge] no BRIDGE_WEBHOOK_SECRET/ACCESS_TOKEN — generated and wrote to .env',
  )
  console.warn(`[dsh-wechat-bridge] token (keep secret): ${token}`)
  return token
}

export function loadConfig(cwd = process.cwd()): BridgeConfig {
  const mode = (process.env.AGENT_MODE ?? 'sdk').toLowerCase()
  const agentMode: AgentMode = mode === 'echo' ? 'echo' : 'sdk'
  const scope = (process.env.SESSION_SCOPE ?? 'chat_sender').toLowerCase()
  const accessToken = resolveAccessToken(cwd)
  if (!accessToken) {
    throw new Error(
      'BRIDGE_WEBHOOK_SECRET or ACCESS_TOKEN is required (no-token → require token)',
    )
  }
  return {
    // Prefer 127.0.0.1 so host openresty can proxy_pass http://127.0.0.1:8787
    // (Docker compose should set BRIDGE_HOST=0.0.0.0 and publish 127.0.0.1:8787:8787)
    host: process.env.BRIDGE_HOST ?? '127.0.0.1',
    port: num('BRIDGE_PORT', 8787),
    accessToken,
    wechatClientBaseUrl: (process.env.WECHAT_CLIENT_BASE_URL ?? 'http://127.0.0.1:9000').replace(
      /\/$/,
      '',
    ),
    wechatClientApiToken: process.env.WECHAT_CLIENT_API_TOKEN ?? '',
    aiTrigger: process.env.AI_TRIGGER ?? '',
    ignoreSelf: bool('IGNORE_SELF', true),
    textOnly: bool('TEXT_ONLY', true),
    agentMode,
    dshBin: process.env.DSH_BIN ?? '',
    dshHome: resolve(cwd, process.env.DSH_HOME ?? './.dsh-home'),
    dshProfile: process.env.DSH_PROFILE ?? 'sdk',
    dshProvider: process.env.DSH_PROVIDER ?? 'deepseek-official',
    dshModel: process.env.DSH_MODEL ?? 'deepseek-v4-flash',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
    dshPatches: list('DSH_PATCHES').map((p) => resolve(cwd, p)),
    sessionScope: scope === 'chat' ? 'chat' : 'chat_sender',
  }
}
