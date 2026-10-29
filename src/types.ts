/** wechat-robot-client webhook body: SyncMessage subset we care about. */

export interface SKString {
  string?: string
}

export interface WechatRawMessage {
  MsgId?: number
  NewMsgId?: number
  MsgType?: number
  CreateTime?: number
  FromUserName?: SKString
  ToUserName?: SKString
  Content?: SKString
  PushContent?: string
  MsgSource?: string
}

export interface SyncMessagePayload {
  AddMsgs?: WechatRawMessage[]
  [key: string]: unknown
}

export interface WebhookQuery {
  robot_id?: string
  robot_code?: string
  robot_wxid?: string
}

export interface InboundTextMessage {
  dedupeKey: string
  msgId: number
  newMsgId: number
  msgType: number
  fromWxid: string
  toWxid: string
  /** 群聊时为真正发言人 wxid；私聊时等于 fromWxid */
  senderWxid: string
  /** 去掉群前缀后的纯文本 */
  text: string
  isChatRoom: boolean
  createTime: number
  robotWxid: string
  robotCode: string
  robotId: string
}

export interface SendTextResult {
  ok: boolean
  status: number
  body: string
}
