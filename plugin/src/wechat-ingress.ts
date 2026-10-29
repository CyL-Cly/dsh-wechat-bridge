/**
 * Cordis 插件脚手架（可选）。
 * 真正收微信消息目前由 sibling HTTP server（src/index.ts）完成：
 * wechat-robot-client system_settings.webhook_url → bridge → dsh SDK → send/text。
 *
 * 若以后要把入站迁进 dsh 进程，可在此 inject webServer / agents，
 * 参考 packages/experimental/webhook-github。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'wechat-ingress'

export interface Config {
  enabled: boolean
  note?: string
}

export function apply(ctx: Context, config: Config): void {
  if (!config?.enabled) {
    console.log('[wechat-ingress] disabled (use dsh-wechat-bridge HTTP server)')
    return
  }
  console.log('[wechat-ingress]', config.note ?? 'enabled placeholder — wire HTTP route here')
  ctx.effect(() => {
    return () => {
      /* teardown */
    }
  }, 'wechat-ingress')
}
