// 法学引注生成（《法学引注手册》2020 体系，兼容 GB/T 7714）
function joinAuthors(authors) {
  const list = (authors ?? []).filter(Boolean)
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]}、${list[1]}`
  return `${list[0]}等`
}

/**
 * 生成引注字符串。
 * 法学引注手册格式示例：
 * - 期刊：王利明：《论效力性强制性规定的识别标准》，载《中国法学》2023年第3期，第45页。
 * - 学位论文：韩世远：《情势变更原则研究》，清华大学法学院2020年博士学位论文，第12页。
 * - 著作：崔建远：《合同法》，北京大学出版社2021年版，第88页。
 * - 网络来源：作者：《文章名》，载网站名2023年5月1日，https://…
 */
export function formatCitation(fields, style = '法学引注手册') {
  const authors = joinAuthors(fields.authors)
  const title = fields.title ?? ''
  const missing = []
  const need = (v) => {
    if (v === undefined || v === null || v === '') {
      missing.push(true)
      return '〔待补〕'
    }
    return v
  }

  if (style === 'GB/T 7714') {
    const parts = [
      authors ? authors + '.' : '',
      title ? title + (fields.type === 'thesis' ? '[D]' : fields.type === 'book' ? '[M]' : '[J]') + '.' : '',
      fields.type === 'thesis'
        ? need(fields.university) + ', ' + need(fields.year) + '.'
        : fields.journal
          ? need(fields.journal) + ', ' + need(fields.year) + (fields.issue ? '(' + need(fields.issue) + ')' : '') + '.'
          : fields.publisher
            ? need(fields.publisher) + ', ' + need(fields.year) + '.'
            : '',
    ]
    return { citation: parts.join(' ').replace(/\s+/g, ' ').trim(), missing_fields: missing.length }
  }

  // 法学引注手册
  let body
  switch (fields.type) {
    case 'thesis':
      body = `${authors}：《${title}》，${need(fields.university)}${need(fields.year)}年${need(fields.degree ?? '博士')}学位论文`
      break
    case 'book':
      body = `${authors}：《${title}》，${need(fields.publisher)}${need(fields.year)}年版`
      break
    case 'web':
      body = `${authors}：《${title}》，载${need(fields.site)}${need(fields.date)}，${need(fields.url)}`
      break
    default: // journal
      body = `${authors}：《${title}》，载《${need(fields.journal)}》${need(fields.year)}年第${need(fields.issue)}期`
  }
  if (fields.page) body += `，第${fields.page}页`
  return { citation: body + '。', missing_fields: missing.length }
}
