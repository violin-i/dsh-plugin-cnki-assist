// 知网导出题录文件解析（纯函数：文本输入 → 结构化记录输出）

// 中文标签 → 记录字段（双语标签 Title-题名 会先归一化去掉英文前缀）
const CNKI_LABELS = {
  题名: 'title',
  篇名: 'title',
  文献题名: 'title',
  作者: 'authors',
  机构: 'organization',
  单位: 'organization',
  关键词: 'keywords',
  摘要: 'abstract',
  来源: 'source',
  刊名: 'source',
  期刊名: 'source',
  文献来源: 'source',
  发表时间: 'pub_date',
  发表年度: 'pub_date',
  年份: 'pub_date',
  页码: 'pages',
  下载地址: 'url',
  链接: 'url',
  网址: 'url',
  来源库: 'type',
  DOI: 'doi',
}

// 匹配标签行（题名：… / Title-题名: …），返回归一化中文标签与值
function matchLabel(line) {
  const m = line.match(/^([^\s：:]{1,24})\s*[：:]\s*(.*)$/)
  if (!m) return null
  const zh = m[1].replace(/^[A-Za-z]+\s*-\s*/, '')
  const key = CNKI_LABELS[zh]
  return key ? { key, value: m[2].trim() } : null
}

// EndNote 标签（%T/%A/…）→ 记录字段
const ENDNOTE_TAGS = {
  T: 'title',
  A: 'authors',
  J: 'source',
  D: 'pub_date',
  K: 'keywords',
  X: 'abstract',
  U: 'url',
  P: 'pages',
  V: 'volume',
  N: 'issue',
  0: 'type',
}

// RefWorks 标签（T1/A1/…）→ 记录字段
const REFWORKS_TAGS = {
  T1: 'title',
  A1: 'authors',
  JF: 'source',
  YR: 'pub_date',
  KW: 'keywords',
  AB: 'abstract',
  UL: 'url',
  OL: 'url',
  SP: 'pages',
  RT: 'type',
}

function splitList(value) {
  return value
    .split(/[;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function emptyRecord() {
  return { title: '', authors: [], source: '', pub_date: '', keywords: [], abstract: '', type: '', url: '' }
}

function finalize(rec) {
  const out = {}
  for (const [k, v] of Object.entries(rec)) {
    if (v === '' || v === null || v === undefined) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

// 知网"自定义"文本导出：标签行（题名：xxx）成块，块间以空行或长横线分隔
function parseCnkiCustom(text) {
  const blocks = text.split(/\n\s*(?:[=\-—]{10,})?\s*\n+/)
  const papers = []
  let skipped = 0
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim())
    if (!lines.length) continue
    const rec = emptyRecord()
    let lastField = null
    for (const line of lines) {
      const hit = matchLabel(line)
      if (hit) {
        const { key, value } = hit
        if (key === 'authors' || key === 'keywords') rec[key] = splitList(value)
        else rec[key] = value
        lastField = key
      } else if (lastField === 'abstract') {
        rec.abstract += (rec.abstract ? ' ' : '') + line.trim()
      }
    }
    if (rec.title) papers.push(finalize(rec))
    else skipped++
  }
  return { papers, skipped }
}

// EndNote 格式：%标签 值，记录以空行分隔
function parseEndNote(text) {
  const papers = []
  let cur = null
  let lastIsAbstract = false
  const flush = () => {
    if (cur && cur.title) papers.push(finalize(cur))
    cur = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      flush()
      continue
    }
    const m = line.match(/^%([0-9A-Za-z])\s?(.*)$/)
    if (m) {
      if (!cur) cur = emptyRecord()
      const key = ENDNOTE_TAGS[m[1]]
      lastIsAbstract = key === 'abstract'
      if (!key) continue
      const value = m[2].trim()
      if (key === 'authors' || key === 'keywords') cur[key].push(...splitList(value))
      else cur[key] = value
    } else if (cur && lastIsAbstract) {
      cur.abstract += ' ' + line.trim()
    }
  }
  flush()
  return { papers, skipped: 0 }
}

// RefWorks 格式：XX 值，新记录以 RT 行开始
function parseRefWorks(text) {
  const papers = []
  let cur = null
  let lastIsAbstract = false
  const flush = () => {
    if (cur && cur.title) papers.push(finalize(cur))
    cur = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const m = line.match(/^(RT|T1|A1|JF|YR|KW|AB|UL|OL|SP)\s+(.*)$/)
    if (!m) {
      if (cur && lastIsAbstract) cur.abstract += ' ' + line.trim()
      continue
    }
    const tag = m[1]
    if (tag === 'RT') flush()
    if (!cur) cur = emptyRecord()
    const key = REFWORKS_TAGS[tag]
    lastIsAbstract = key === 'abstract'
    const value = m[2].trim()
    if (key === 'authors') cur.authors.push(...splitList(value))
    else if (key === 'keywords') cur.keywords.push(...splitList(value))
    else cur[key] = value
  }
  flush()
  return { papers, skipped: 0 }
}

// 制表符分隔（知网 Excel 导出转存的 txt：首行为表头）
function parseTsv(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (!lines.length) return { papers: [], skipped: 0 }
  const header = lines[0].split('\t').map((h) => h.trim().replace(/\s+$/, ''))
  const keyOrder = header.map((h) => CNKI_LABELS[h]).filter(Boolean)
  if (keyOrder.length < 2) return { papers: [], skipped: 1 }
  const papers = []
  let skipped = 0
  for (const line of lines.slice(1)) {
    const cells = line.split('\t')
    const rec = emptyRecord()
    header.forEach((h, i) => {
      const key = CNKI_LABELS[h.replace(/^[A-Za-z]+\s*-\s*/, '')]
      if (!key) return
      const value = (cells[i] ?? '').trim()
      if (!value) return
      if (key === 'authors' || key === 'keywords') rec[key] = splitList(value)
      else rec[key] = value
    })
    if (rec.title) papers.push(finalize(rec))
    else skipped++
  }
  return { papers, skipped }
}

function detectFormat(text) {
  if (/^\s*RT\s+\S/m.test(text)) return { format: 'refworks', parse: parseRefWorks }
  if (/(^|\n)%[0-9A-Za-z]\s/.test(text)) return { format: 'endnote', parse: parseEndNote }
  // 知网导出页"自定义"格式的真实形态：Title-题名: … 双语标签
  if (/(Title|Summary|Author|SrcDatabase)-[^\s：:]+\s*[：:]/.test(text)) {
    return { format: 'cnki-custom', parse: parseCnkiCustom }
  }
  if (/^[^\n]*\t/.test(text) && /(题名|篇名)/.test(text.split('\n')[0])) return { format: 'tsv', parse: parseTsv }
  if (/(题名|篇名|文献题名)\s*[：:]/.test(text)) return { format: 'cnki-custom', parse: parseCnkiCustom }
  return null
}

export function parseCnkiExport(text) {
  // \0 剥离：某些导出/转存路径会在文件尾部留 NUL 填充字节
  const normalized = text.replace(/\0/g, '').replace(/\r\n?/g, '\n')
  const detector = detectFormat(normalized)
  if (!detector) {
    throw new Error(
      '无法识别的导出格式。支持：知网"自定义"文本导出（题名：… 标签式）、EndNote（%T …）、RefWorks（RT/T1 …）、制表符分隔 txt。' +
        '请在知网检索结果页勾选文献 → 导出文献 → 选择以上格式 → 导出为 txt 后重试。',
    )
  }
  const { papers, skipped } = detector.parse(normalized)
  if (!papers.length) {
    throw new Error(`按 ${detector.format} 格式解析，但未得到任何含题名的记录，请确认文件内容是否完整。`)
  }
  const warnings = []
  if (skipped > 0) warnings.push(`跳过了 ${skipped} 个缺少题名的块`)
  return { format: detector.format, count: papers.length, papers, warnings }
}

// 字节解码：BOM 优先 → 严格 UTF-8 → GB18030 兜底（知网导出的 txt 常为 GB 系编码）
export function decodeExportBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('gb18030').decode(buf)
  }
}
