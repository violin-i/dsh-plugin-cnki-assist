// PDF 文本提取（pdfjs-dist，纯 JS 依赖；中文需 cmaps，必须用绝对路径而非 file:// URL）
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/**
 * 提取 PDF 全文。
 * @param {Uint8Array} data
 * @returns {Promise<{pageCount: number, text: string, pages: string[]}>}
 */
export async function extractPdfText(data) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const require = createRequire(import.meta.url)
  const base = dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    cMapUrl: resolve(base, '../../cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: resolve(base, '../../standard_fonts') + '/',
  }).promise
  const pageCount = doc.numPages
  const pages = []
  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    // item.hasEOL 携带换行信息；恢复行结构对标题识别与分块至关重要
    pages.push(
      tc.items
        .map((i) => i.str + (i.hasEOL ? '\n' : ''))
        .join('')
        .replace(/ ?\n ?/g, '\n'),
    )
  }
  await doc.destroy()
  const text = pages.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return { pageCount, text, pages }
}
