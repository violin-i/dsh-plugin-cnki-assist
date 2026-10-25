// 知网访问守护（纯函数）：拦下载、限频率。状态仅在内存中，插件重载后清零。

export const CNKI_HOST_RE = /cnki\.(?:net|com\.cn)|\.cnki\./i

// 仅匹配"下载全文"类端点；详情页(detail.aspx)、检索页(defaultresult)不匹配
export const CNKI_DOWNLOAD_RE =
  /kcms2?\/article\/download|kcms\/download|download\.aspx|kns8s?\/download|\/download\?|getDocumentPage|filename=[^&\s"']*\.(?:caj|pdf|nh)(?:[&\s"']|$)/i

export const DEFAULT_GUARD_OPTIONS = {
  maxCalls: 12, // 窗口内最多知网访问次数
  windowMs: 10 * 60 * 1000, // 10 分钟窗口
  minIntervalMs: 4000, // 两次访问最小间隔
}

/**
 * 创建守护决策器。
 * @returns {(toolName: string, args: unknown) => {action:'allow'} | {action:'deny', reason:string}}
 */
export function createCnkiGuard(options = {}) {
  const { maxCalls, windowMs, minIntervalMs } = { ...DEFAULT_GUARD_OPTIONS, ...options }
  const now = options.now ?? Date.now
  let calls = []
  let last = -Infinity

  return function decide(_toolName, args) {
    const s = typeof args === 'string' ? args : JSON.stringify(args ?? {})
    if (!CNKI_HOST_RE.test(s)) return { action: 'allow' }

    if (CNKI_DOWNLOAD_RE.test(s)) {
      return {
        action: 'deny',
        reason:
          '知网全文下载已被本插件的护栏拦截：自动化批量下载会导致学校 IP 段被封禁。' +
          '请把文献链接交给用户，由用户在浏览器中手动下载 PDF。',
      }
    }

    const t = now()
    if (t - last < minIntervalMs) {
      return {
        action: 'deny',
        reason: `知网访问过于频繁（间隔不足 ${Math.round(minIntervalMs / 1000)} 秒）。请等待片刻再试，保持人工检索的节奏。`,
      }
    }
    calls = calls.filter((ts) => t - ts < windowMs)
    if (calls.length >= maxCalls) {
      return {
        action: 'deny',
        reason: `知网访问已达到 ${maxCalls} 次/${Math.round(windowMs / 60000)} 分钟的限额。` +
          '请改用人工链路：让用户在知网手动导出题录文件，再用 cnki_parse_export 解析。',
      }
    }
    calls.push(t)
    last = t
    return { action: 'allow' }
  }
}
