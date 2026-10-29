import type { InboundTextMessage, SyncMessagePayload, WebhookQuery, WechatRawMessage } from './types.js'

const MSG_TYPE_TEXT = 1

function sk(v?: { string?: string }): string {
  return (v?.string ?? '').trim()
}

/** 群文本常见形态：`wxid_xxx:\n你好` 或 `wxid_xxx:你好` */
export function parseGroupContent(raw: string): { senderWxid: string; text: string } {
  const idx = raw.indexOf(':')
  if (idx <= 0) return { senderWxid: '', text: raw }
  const maybeSender = raw.slice(0, idx).trim()
  // wxid / gh_ / 数字微信号粗判
  if (!/^(wxid_|gh_|[a-zA-Z][\w-]{3,})$/.test(maybeSender) && !maybeSender.includes('@')) {
    return { senderWxid: '', text: raw }
  }
  let text = raw.slice(idx + 1)
  if (text.startsWith('\n')) text = text.slice(1)
  return { senderWxid: maybeSender, text: text.trim() }
}

export function isChatRoomId(wxid: string): boolean {
  return wxid.includes('@chatroom')
}

export function extractInboundTexts(
  body: SyncMessagePayload,
  query: WebhookQuery,
  opts: { textOnly: boolean; ignoreSelf: boolean; aiTrigger: string },
): InboundTextMessage[] {
  const robotWxid = query.robot_wxid ?? ''
  const robotCode = query.robot_code ?? ''
  const robotId = query.robot_id ?? ''
  const msgs = body.AddMsgs ?? []
  const out: InboundTextMessage[] = []

  for (const m of msgs) {
    const parsed = normalizeOne(m, robotWxid, robotCode, robotId, opts)
    if (parsed) out.push(parsed)
  }
  return out
}

function normalizeOne(
  m: WechatRawMessage,
  robotWxid: string,
  robotCode: string,
  robotId: string,
  opts: { textOnly: boolean; ignoreSelf: boolean; aiTrigger: string },
): InboundTextMessage | null {
  const msgType = Number(m.MsgType ?? 0)
  if (opts.textOnly && msgType !== MSG_TYPE_TEXT) return null

  const fromWxid = sk(m.FromUserName)
  const toWxid = sk(m.ToUserName)
  if (!fromWxid) return null

  const chatRoom = isChatRoomId(fromWxid)
  const rawContent = sk(m.Content)
  let senderWxid = fromWxid
  let text = rawContent

  if (chatRoom) {
    const g = parseGroupContent(rawContent)
    if (g.senderWxid) senderWxid = g.senderWxid
    text = g.text
  }

  if (opts.ignoreSelf && robotWxid && senderWxid === robotWxid) return null
  // 自己设备发出的：From == robot
  if (opts.ignoreSelf && robotWxid && fromWxid === robotWxid && !chatRoom) return null

  if (chatRoom && opts.aiTrigger) {
    if (!text.startsWith(opts.aiTrigger)) return null
    text = text.slice(opts.aiTrigger.length).trim() || '在吗？'
  }

  if (!text) return null

  const newMsgId = Number(m.NewMsgId ?? 0)
  const msgId = Number(m.MsgId ?? 0)
  return {
    dedupeKey: `${robotCode}:${newMsgId || msgId}:${fromWxid}:${senderWxid}`,
    msgId,
    newMsgId,
    msgType,
    fromWxid,
    toWxid,
    senderWxid,
    text,
    isChatRoom: chatRoom,
    createTime: Number(m.CreateTime ?? 0),
    robotWxid,
    robotCode,
    robotId,
  }
}
