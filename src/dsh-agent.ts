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

/**
 * 封装 dsh SDK。AGENT_MODE=echo 时不拉起子进程，方便联调 webhook/发消息。
 * sdk 模式惰性 import @deepseek-ai/dsh-sdk-client。
 */
export class DshAgent {
  private harness: HarnessLike | null = null

  constructor(private readonly cfg: BridgeConfig) {}

  async ensureStarted(): Promise<void> {
    if (this.cfg.agentMode === 'echo') return
    if (this.harness) return

    if (this.cfg.deepseekApiKey && !process.env.DEEPSEEK_API_KEY) {
      process.env.DEEPSEEK_API_KEY = this.cfg.deepseekApiKey
    }

    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const options: Record<string, unknown> = {
      profile: this.cfg.dshProfile,
      provider: this.cfg.dshProvider,
      model: this.cfg.dshModel,
      dshHome: this.cfg.dshHome,
    }
    if (this.cfg.dshBin) options.dshBin = this.cfg.dshBin
    if (this.cfg.dshPatches.length) options.patches = this.cfg.dshPatches

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
