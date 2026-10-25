import { createCnkiGuard } from './lib/guard-core.js'

export const name = 'cnki-assist-guard'
export const inject = ['tools']

// 工具执行前门禁：对涉及知网的浏览器调用做"拦下载 + 限频率"。
// 与浏览器提供方无关——拦截发生在工具执行管线层。
export function apply(ctx) {
  const decide = createCnkiGuard()
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = decide(exec.name, exec.arguments)
    if (decision.action === 'deny') {
      ctx.logger?.info?.(`[cnki-assist] 拦截 ${exec.name}: ${decision.reason.slice(0, 40)}…`)
      return { kind: 'deny', reason: decision.reason }
    }
    return next()
  })
}
