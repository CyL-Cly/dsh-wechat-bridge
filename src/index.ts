import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { loadConfig } from './config.js'
import { DshAgent } from './dsh-agent.js'
import { DedupeCache } from './session-map.js'
import { extractInboundTexts } from './webhook.js'
import { WechatRobotClient } from './wechat-client.js'
import type { SyncMessagePayload, WebhookQuery } from './types.js'

const cfg = loadConfig()
const agent = new DshAgent(cfg)
const wechat = new WechatRobotClient(cfg)
const dedupe = new DedupeCache()

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw) as unknown
}

function queryOf(url: URL): WebhookQuery {
  return {
    robot_id: url.searchParams.get('robot_id') ?? undefined,
    robot_code: url.searchParams.get('robot_code') ?? undefined,
    robot_wxid: url.searchParams.get('robot_wxid') ?? undefined,
  }
}

/** Optional: when accessToken set, require X-Bridge-Secret / X-Webhook-Secret / Bearer. Empty token = open. */
function checkSecret(req: IncomingMessage): boolean {
  const expected = cfg.accessToken
  if (!expected) return true
  const h =
    req.headers['x-bridge-secret'] ??
    req.headers['x-webhook-secret'] ??
    req.headers.authorization
  const val = Array.isArray(h) ? h[0] : h
  if (!val) return false
  if (val === expected) return true
  if (val === `Bearer ${expected}`) return true
  return false
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!checkSecret(req)) {
    send(res, 401, { ok: false, error: 'unauthorized', hint: 'missing or wrong token' })
    return
  }
  const body = (await readJson(req)) as SyncMessagePayload
  const query = queryOf(url)
  const messages = extractInboundTexts(body, query, {
    textOnly: cfg.textOnly,
    ignoreSelf: cfg.ignoreSelf,
    aiTrigger: cfg.aiTrigger,
  })

  // 先快速 ACK，避免 wechat-robot-client webhook 超时；后台处理
  send(res, 200, { ok: true, accepted: messages.length })

  for (const msg of messages) {
    if (dedupe.check(msg.dedupeKey)) {
      console.log(`[dedupe] skip ${msg.dedupeKey}`)
      continue
    }
    void processOne(msg)
  }
}

async function processOne(msg: Awaited<ReturnType<typeof extractInboundTexts>>[number]): Promise<void> {
  const label = `${msg.fromWxid} <- ${msg.senderWxid}`
  try {
    console.log(`[in] ${label}: ${msg.text.slice(0, 120)}`)
    const reply = await agent.reply(msg)
    const at = msg.isChatRoom ? [msg.senderWxid] : []
    const result = await wechat.sendText(msg.fromWxid, reply.text, at)
    if (!result.ok) {
      console.error(`[out-fail] ${label} status=${result.status} body=${result.body.slice(0, 300)}`)
      return
    }
    console.log(`[out] ${label} session=${reply.sessionId} bytes=${reply.text.length}`)
  } catch (err) {
    console.error(`[err] ${label}`, err)
    try {
      await wechat.sendText(msg.fromWxid, `桥接错误: ${err instanceof Error ? err.message : String(err)}`)
    } catch {
      /* ignore */
    }
  }
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const host = req.headers.host ?? `127.0.0.1:${cfg.port}`
      const url = new URL(req.url ?? '/', `http://${host}`)
      // /health stays open for openresty / probe (no secrets in body)
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        send(res, 200, {
          ok: true,
          service: 'dsh-wechat-bridge',
          agentMode: cfg.agentMode,
          profile: cfg.dshProfile,
          auth: cfg.accessToken ? 'optional-token' : 'open',
        })
        return
      }
      if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/wechat/webhook')) {
        await handleWebhook(req, res, url)
        return
      }
      send(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      console.error('[http]', err)
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })()
})

server.listen(cfg.port, cfg.host, () => {
  console.log(
    `[dsh-wechat-bridge] http://${cfg.host}:${cfg.port} mode=${cfg.agentMode} -> ${cfg.wechatClientBaseUrl}`,
  )
  console.log(
    `[dsh-wechat-bridge] webhook: POST /webhook  (auth: X-Bridge-Secret or Authorization: Bearer)`,
  )
  console.log(
    `[dsh-wechat-bridge] openresty: proxy_pass http://127.0.0.1:${cfg.port}; + proxy_set_header X-Bridge-Secret <token>;`,
  )
})

async function shutdown(signal: string): Promise<void> {
  console.log(`[dsh-wechat-bridge] ${signal}, shutting down…`)
  server.close()
  await agent.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
