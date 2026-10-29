import { config as loadDotenv } from 'dotenv'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
  /** Optional shared secret for webhook/API (BRIDGE_WEBHOOK_SECRET or ACCESS_TOKEN). Empty = open. */
  accessToken: string
  wechatClientBaseUrl: string
  wechatClientApiToken: string
  aiTrigger: string
  ignoreSelf: boolean
  textOnly: boolean
  agentMode: AgentMode
  dshBin: string
  /** Shared with `dsh web` so WeChat sessions appear in the UI. */
  dshHome: string
  dshProfile: string
  /** Optional escape hatch; empty → read agent-default-model from dshHome profiles. */
  dshProvider: string
  dshModel: string
  dshPatches: string[]
  /** Workspace cwd recorded on SDK sessions. */
  agentCwd: string
  sessionScope: 'chat' | 'chat_sender'
}

/** Shared home with dsh web: $DSH_HOME or ~/.dsh (never a bridge-private tree by default). */
export function defaultDshHome(cwd = process.cwd()): string {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return resolve(cwd, fromEnv)
  return join(homedir(), '.dsh')
}

/** Optional: BRIDGE_WEBHOOK_SECRET or ACCESS_TOKEN. Empty = no webhook auth. */
export function resolveAccessToken(_cwd = process.cwd()): string {
  return (
    (process.env.BRIDGE_WEBHOOK_SECRET ?? '').trim() ||
    (process.env.ACCESS_TOKEN ?? '').trim()
  )
}

export function loadConfig(cwd = process.cwd()): BridgeConfig {
  const mode = (process.env.AGENT_MODE ?? 'sdk').toLowerCase()
  const agentMode: AgentMode = mode === 'echo' ? 'echo' : 'sdk'
  const scope = (process.env.SESSION_SCOPE ?? 'chat_sender').toLowerCase()
  const accessToken = resolveAccessToken(cwd)
  return {
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
    // Default: same home as `dsh web` (~/.dsh), NOT a private ./`.dsh-home`.
    dshHome: defaultDshHome(cwd),
    dshProfile: process.env.DSH_PROFILE ?? 'sdk',
    // Empty = resolve from $DSH_HOME/profiles/*/cordis.patch.yml agent-default-model.
    dshProvider: (process.env.DSH_PROVIDER ?? '').trim(),
    dshModel: (process.env.DSH_MODEL ?? '').trim(),
    dshPatches: list('DSH_PATCHES').map((p) => resolve(cwd, p)),
    agentCwd: resolve(cwd, process.env.AGENT_CWD ?? cwd),
    sessionScope: scope === 'chat' ? 'chat' : 'chat_sender',
  }
}
