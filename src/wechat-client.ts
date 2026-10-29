import type { BridgeConfig } from './config.js'
import type { SendTextResult } from './types.js'

export class WechatRobotClient {
  constructor(private readonly cfg: BridgeConfig) {}

  async sendText(toWxid: string, content: string, at: string[] = []): Promise<SendTextResult> {
    const url = `${this.cfg.wechatClientBaseUrl}/api/v1/robot/message/send/text`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.cfg.wechatClientApiToken) {
      headers.Authorization = `Bearer ${this.cfg.wechatClientApiToken}`
      headers['X-API-Token'] = this.cfg.wechatClientApiToken
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to_wxid: toWxid, content, at }),
    })
    const body = await res.text()
    return { ok: res.ok, status: res.status, body }
  }
}
