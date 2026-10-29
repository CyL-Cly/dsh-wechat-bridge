import type { BridgeConfig } from './config.js'
import type { InboundTextMessage } from './types.js'
import { createHash } from 'node:crypto'

/** 稳定、可恢复的 session 键 → 短 id（dsh sessionId 建议精简） */
export function sessionIdFor(msg: InboundTextMessage, scope: BridgeConfig['sessionScope']): string {
  const raw =
    scope === 'chat'
      ? `${msg.robotCode}|${msg.fromWxid}`
      : `${msg.robotCode}|${msg.fromWxid}|${msg.senderWxid}`
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 24)
  return `wx_${hash}`
}

export class DedupeCache {
  private readonly seen = new Map<string, number>()
  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly max = 5000) {}

  /** @returns true if this key was already seen recently */
  check(key: string): boolean {
    const now = Date.now()
    this.gc(now)
    if (this.seen.has(key)) return true
    this.seen.set(key, now)
    if (this.seen.size > this.max) {
      const first = this.seen.keys().next().value
      if (first) this.seen.delete(first)
    }
    return false
  }

  private gc(now: number): void {
    for (const [k, t] of this.seen) {
      if (now - t > this.ttlMs) this.seen.delete(k)
    }
  }
}
