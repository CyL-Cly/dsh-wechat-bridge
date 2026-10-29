import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

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
  webhookSecret: string
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

export function loadConfig(cwd = process.cwd()): BridgeConfig {
  const mode = (process.env.AGENT_MODE ?? 'sdk').toLowerCase()
  const agentMode: AgentMode = mode === 'echo' ? 'echo' : 'sdk'
  const scope = (process.env.SESSION_SCOPE ?? 'chat_sender').toLowerCase()
  return {
    host: process.env.BRIDGE_HOST ?? '0.0.0.0',
    port: num('BRIDGE_PORT', 8787),
    webhookSecret: process.env.BRIDGE_WEBHOOK_SECRET ?? '',
    wechatClientBaseUrl: (process.env.WECHAT_CLIENT_BASE_URL ?? 'http://127.0.0.1:9001').replace(/\/$/, ''),
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
