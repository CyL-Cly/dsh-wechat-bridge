import type { BridgeConfig } from './config.js'
import type { SendTextResult } from './types.js'

export type RobotApiResult = SendTextResult

function buildUrl(baseUrl: string, apiPath: string, query: Record<string, string | undefined>): string {
  const u = new URL(apiPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') u.searchParams.set(k, v)
  }
  return u.toString()
}

export class WechatRobotClient {
  constructor(private readonly cfg: BridgeConfig) {}

  private robotHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra }
    if (this.cfg.wechatClientApiToken) {
      headers.Authorization = `Bearer ${this.cfg.wechatClientApiToken}`
      headers['X-API-Token'] = this.cfg.wechatClientApiToken
    }
    return headers
  }

  private async get(apiPath: string, query: Record<string, string | undefined> = {}): Promise<RobotApiResult> {
    const url = buildUrl(this.cfg.wechatClientBaseUrl, apiPath, query)
    const res = await fetch(url, {
      method: 'GET',
      headers: this.robotHeaders(),
    })
    const body = await res.text()
    return { ok: res.ok, status: res.status, body }
  }

  async sendText(toWxid: string, content: string, at: string[] = []): Promise<SendTextResult> {
    const url = `${this.cfg.wechatClientBaseUrl}/api/v1/robot/message/send/text`
    const res = await fetch(url, {
      method: 'POST',
      headers: this.robotHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ to_wxid: toWxid, content, at }),
    })
    const body = await res.text()
    return { ok: res.ok, status: res.status, body }
  }

  /** 朋友圈列表。robot 参数名有 typo：frist_page_md5 */
  momentsList(fristPageMd5 = '', maxId = '0'): Promise<RobotApiResult> {
    return this.get('/api/v1/robot/moments/list', {
      frist_page_md5: fristPageMd5,
      max_id: maxId,
    })
  }

  /** 某好友朋友圈分页详情 */
  momentsUserDetail(toWxid: string, fristPageMd5 = '', maxId = '0'): Promise<RobotApiResult> {
    return this.get('/api/v1/robot/moments/get-detail', {
      Towxid: toWxid,
      Fristpagemd5: fristPageMd5,
      Maxid: maxId,
    })
  }

  /** 单条朋友圈详情 */
  momentsIdDetail(toWxid: string, id: string): Promise<RobotApiResult> {
    return this.get('/api/v1/robot/moments/get-id-detail', {
      Towxid: toWxid,
      Id: id,
    })
  }

  /** 触发同步朋友圈 */
  momentsSync(): Promise<RobotApiResult> {
    return this.get('/api/v1/robot/moments/sync')
  }

  /** 下载朋友圈媒体 */
  momentsDownMedia(url: string, key = ''): Promise<RobotApiResult> {
    return this.get('/api/v1/robot/moments/down-media', { url, key })
  }
}
