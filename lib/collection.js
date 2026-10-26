// 文献库核心：分块 + BM25 检索 + 概念扩展 + 笔记/进度 + 文件型存储（零外部依赖，索引在加载时内存重建）
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, basename, extname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { extractPdfText } from './pdf-extract.js'

// ---------- 分块 ----------

/** 按段落聚合分块；块间带字符级重叠，保持语义连续 */
export function chunkText(text, { target = 480, overlap = 64 } = {}) {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean)
  const chunks = []
  let cur = ''
  for (const para of paras) {
    if (cur && (cur + para).length > target) {
      chunks.push(cur)
      cur = cur.slice(-overlap) + para
    } else {
      cur += (cur ? '' : '') + para
    }
    // 超长单段（如无换行的 PDF 提取结果）硬切
    while (cur.length > target * 2) {
      chunks.push(cur.slice(0, target * 2))
      cur = cur.slice(target * 2 - overlap)
    }
  }
  if (cur.trim()) chunks.push(cur)
  return chunks.map((c) => c.trim()).filter((c) => c.length >= 8)
}

// ---------- 中文 BM25 ----------

/** 中文 bigram + ASCII 词 */
export function tokenize(text) {
  const norm = text.toLowerCase()
  const tokens = []
  for (const w of norm.match(/[a-z0-9]+/g) ?? []) tokens.push(w)
  for (const run of norm.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.push(run)
    else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

function bm25Scores(queryTokens, chunkTokens, { k1 = 1.5, b = 0.75 } = {}) {
  const N = chunkTokens.length
  const avgLen = chunkTokens.reduce((s, t) => s + t.length, 0) / (N || 1) || 1
  const df = new Map()
  for (const tokens of chunkTokens) {
    const seen = new Set(tokens)
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const scores = new Array(N).fill(0)
  for (const q of new Set(queryTokens)) {
    const d = df.get(q)
    if (!d) continue
    const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5))
    for (let i = 0; i < N; i++) {
      const tokens = chunkTokens[i]
      let tf = 0
      for (const t of tokens) if (t === q) tf++
      if (!tf) continue
      scores[i] += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * tokens.length) / avgLen))
    }
  }
  return scores
}

// ---------- 法律概念扩展 ----------

/** 内置法律概念同义表：检索时自动补齐相关表述，提升召回。仅本地静态映射，零网络。 */
export const LEGAL_CONCEPTS = [
  ['合同无效', ['效力性强制性规定', '无效后果', '合同效力', '自始无效']],
  ['效力性强制性规定', ['强制性规定', '合同无效', '规范性质', '管理性强制性规定']],
  ['管理性强制性规定', ['强制性规定', '规范性质', '合同效力', '效力性强制性规定']],
  ['合同效力', ['合同有效', '无效', '可撤销', '效力待定']],
  ['情势变更', ['不可抗力', '继续履行', '再交涉', '公平原则', '解除合同']],
  ['不可抗力', ['情势变更', '免责事由', '解除合同', '不能预见']],
  ['合同解除', ['解除权', '通知解除', '解除后果', '违约方解除', '根本违约']],
  ['根本违约', ['合同解除', '不能实现合同目的']],
  ['违约责任', ['损害赔偿', '违约金', '继续履行', '可预见性规则']],
  ['违约金', ['违约金调整', '过分高于损失', '实际损失', '违约责任']],
  ['定金', ['定金罚则', '违约金', '定金返还']],
  ['表见代理', ['无权代理', '善意相对人', '合理信赖', '越权代理']],
  ['善意取得', ['无权处分', '善意第三人', '合理价格', '不动产物权']],
  ['侵权责任', ['过错责任', '因果关系', '损害赔偿', '归责原则']],
  ['共同侵权', ['连带责任', '意思联络', '帮助侵权']],
  ['格式条款', ['提示说明义务', '格式条款无效', '不利解释', '免责条款']],
  ['保证', ['保证期间', '连带责任保证', '一般保证', '保证合同']],
  ['抵押', ['抵押权', '抵押登记', '优先受偿', '动产抵押']],
  ['股权', ['股东资格', '股权转让', '股东出资', '公司决议']],
  ['股东出资', ['出资不实', '抽逃出资', '股东资格', '发起人责任']],
  ['法人人格否认', ['刺破公司面纱', '财产混同', '滥用法人独立地位', '连带责任']],
  ['劳动合同', ['劳动关系', '经济补偿', '违法解除', '竞业限制']],
  ['电子合同', ['电子签名', '要约承诺', '数据电文', '电子证据']],
  ['诉讼时效', ['时效抗辩', '时效中断', '时效中止', '普通诉讼时效']],
  ['举证责任', ['证明责任', '举证责任倒置', '高度盖然性', '证据规则']],
]

/**
 * 概念扩展：query 命中概念表中的主词时，补充其同义表述。
 * @returns {string[]} 需要追加进检索词的扩展词（不含 query 原有内容）
 */
export function expandQuery(query) {
  const norm = query.toLowerCase()
  const extras = []
  for (const [term, syns] of LEGAL_CONCEPTS) {
    if (norm.includes(term)) {
      for (const s of syns) if (!norm.includes(s) && !extras.includes(s)) extras.push(s)
    }
  }
  return extras
}

// ---------- 片段选择与高亮 ----------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把 terms 在 text 中的出现用【】标出（长词优先，单遍替换不嵌套） */
export function highlightTerms(text, terms) {
  const uniq = [...new Set((terms ?? []).filter((t) => t && t.length >= 2))].sort((a, b) => b.length - a.length)
  if (!uniq.length) return text
  const re = new RegExp(uniq.map(escapeRe).join('|'), 'g')
  return text.replace(re, (m) => `【${m}】`)
}

/** 提取 query 的展示词：按空白切分、去首尾标点、取长度 >=2 的词 */
export function queryTerms(query) {
  return (query.match(/[^\s]+/g) ?? [])
    .map((t) => t.replace(/^[^\u4e00-\u9fffA-Za-z0-9]+|[^\u4e00-\u9fffA-Za-z0-9]+$/g, ''))
    .filter((t) => t.length >= 2)
}

/** 在文本中选一个覆盖命中词最多的窗口 */
export function pickSnippet(text, terms, width = 200) {
  if (text.length <= width) return text
  const uniq = [...new Set(terms.filter(Boolean))]
  if (!uniq.length) return text.slice(0, width) + '…'
  let best = { pos: 0, hits: -1 }
  for (const term of uniq) {
    let idx = text.indexOf(term)
    while (idx >= 0) {
      const start = Math.max(0, idx - Math.floor(width / 3))
      const win = text.slice(start, start + width)
      const hits = uniq.reduce((s, t) => s + (win.includes(t) ? 1 : 0), 0)
      if (hits > best.hits) best = { pos: start, hits }
      idx = text.indexOf(term, idx + 1)
    }
  }
  const start = best.pos
  return (start > 0 ? '…' : '') + text.slice(start, start + width) + (start + width < text.length ? '…' : '')
}

// ---------- 文献库 ----------

export class Library {
  /** @param {string} dir 库目录（存放 library.json 与源文件副本不入） */
  constructor(dir, data) {
    this.dir = dir
    this.data = data ?? Library.empty()
    this.normalize()
  }

  static empty() {
    return { version: 2, nextId: 1, nextNoteId: 1, papers: [] }
  }

  /** v1 数据升级 v2：补 notes / progress 字段（写盘时 version 一并升为 2，v1 读取不受影响） */
  normalize() {
    for (const p of this.data.papers) {
      if (!Array.isArray(p.notes)) p.notes = []
      if (p.progress === undefined) p.progress = null
    }
    if (!this.data.nextNoteId) this.data.nextNoteId = 1
    this.data.version = 2
  }

  static async load(dir) {
    let data
    try {
      data = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8'))
    } catch {
      data = Library.empty()
    }
    if (!data.papers) data = Library.empty()
    const lib = new Library(dir, data)
    // 索引在内存重建（个人库规模小，毫秒级）
    lib.rebuildIndex()
    return lib
  }

  rebuildIndex() {
    this.chunkTokens = []
    this.chunkRefs = [] // { paperId, chunkIndex }
    for (const p of this.data.papers) {
      p.chunks.forEach((_, i) => {
        this.chunkTokens.push(tokenize(p.chunks[i]))
        this.chunkRefs.push({ paperId: p.id, chunkIndex: i })
      })
    }
  }

  async save() {
    this.normalize()
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, 'library.json'), JSON.stringify(this.data), 'utf8')
  }

  listPapers() {
    return this.data.papers.map((p) => ({
      id: p.id,
      title: p.title,
      path: p.path,
      pages: p.pages,
      chars: p.text.length,
      chunks: p.chunks.length,
      addedAt: p.addedAt,
      notes: p.notes.length,
      progress: p.progress ? { offset: p.progress.offset, pct: Math.round((p.progress.offset / Math.max(1, p.text.length)) * 100) } : null,
      meta: p.meta,
    }))
  }

  getPaper(id) {
    return this.data.papers.find((p) => p.id === id || p.title === id)
  }

  /**
   * 从文件入库（.pdf/.txt/.md）。目录则递归收集。
   * @returns {Promise<{added: Array, skipped: Array}>}
   */
  async addPaths(paths, { extract = extractPdfText, now = Date.now } = {}) {
    const files = []
    for (const p of paths) {
      const abs = resolve(p)
      let st
      try {
        st = await stat(abs)
      } catch {
        return { added: [], skipped: [{ path: p, reason: '文件不存在' }] }
      }
      if (st.isDirectory()) {
        const entries = await readdir(abs, { recursive: true })
        for (const e of entries) {
          const ext = extname(e).toLowerCase()
          if (ext === '.pdf' || ext === '.txt' || ext === '.md') files.push(join(abs, e))
        }
      } else files.push(abs)
    }
    const added = []
    const skipped = []
    for (const file of files) {
      const ext = extname(file).toLowerCase()
      try {
        const buf = await readFile(file)
        const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
        const dup = this.data.papers.find((p) => p.hash === hash)
        if (dup) {
          skipped.push({ path: file, reason: `重复（已是 ${dup.id}: ${dup.title}）` })
          continue
        }
        let text, pages
        if (ext === '.pdf') {
          const r = await extract(new Uint8Array(buf))
          if (r.text.replace(/\s/g, '').length < 50) {
            skipped.push({ path: file, reason: '几乎无文本层（扫描版 PDF 需先 OCR）' })
            continue
          }
          text = r.text
          pages = r.pageCount
        } else {
          text = buf.toString('utf8')
          pages = null
        }
        const title = guessTitle(text, file)
        const paper = {
          id: 'p' + this.data.nextId++,
          path: file,
          hash,
          title,
          pages,
          addedAt: new Date(now()).toISOString(),
          meta: {},
          notes: [],
          progress: null,
          text,
          chunks: chunkText(text),
        }
        this.data.papers.push(paper)
        added.push({ id: paper.id, title, pages: paper.pages, chars: text.length, chunks: paper.chunks.length, path: file })
      } catch (e) {
        skipped.push({ path: file, reason: e.message.slice(0, 80) })
      }
    }
    if (added.length) {
      this.rebuildIndex()
      await this.save()
    }
    return { added, skipped }
  }

  removePaper(idOrPathOrTitle) {
    const i = this.data.papers.findIndex(
      (p) => p.id === idOrPathOrTitle || p.path === resolve(idOrPathOrTitle) || p.title === idOrPathOrTitle,
    )
    if (i < 0) return null
    const [removed] = this.data.papers.splice(i, 1)
    this.rebuildIndex()
    return { id: removed.id, title: removed.title }
  }

  // ---------- 笔记 ----------

  /**
   * 添加笔记（摘录 + 批注）。
   * @returns {{note: object}|null} null 表示文献不存在
   */
  addNote(paperId, { quote = '', comment = '', chunkIndex = null } = {}) {
    const p = this.getPaper(paperId)
    if (!p) return null
    const note = {
      id: 'n' + this.data.nextNoteId++,
      quote: String(quote).slice(0, 500),
      comment: String(comment).slice(0, 2000),
      chunk_index: Number.isInteger(chunkIndex) ? chunkIndex : null,
      created_at: new Date().toISOString(),
    }
    p.notes.push(note)
    return { note, paper: { id: p.id, title: p.title } }
  }

  /** 列出笔记；paperId 缺省时返回全库笔记 */
  listNotes(paperId) {
    const papers = paperId ? this.data.papers.filter((p) => p.id === paperId || p.title === paperId) : this.data.papers
    const out = []
    for (const p of papers) {
      for (const n of p.notes) out.push({ paper_id: p.id, title: p.title, ...n })
    }
    return out
  }

  /**
   * 删除笔记。
   * @returns {{paper: object, note: object}|null}
   */
  removeNote(paperId, noteId) {
    const p = this.getPaper(paperId)
    if (!p) return null
    const i = p.notes.findIndex((n) => n.id === noteId)
    if (i < 0) return null
    const [note] = p.notes.splice(i, 1)
    return { paper: { id: p.id, title: p.title }, note }
  }

  // ---------- 阅读进度 ----------

  /**
   * 保存阅读进度。
   * @returns {object|null} {offset, updated_at}
   */
  setProgress(paperId, offset) {
    const p = this.getPaper(paperId)
    if (!p) return null
    const off = Math.max(0, Math.min(Number(offset) || 0, p.text.length))
    p.progress = { offset: off, updated_at: new Date().toISOString() }
    return p.progress
  }

  // ---------- 检索 ----------

  /**
   * BM25 检索，可限定单篇。expand 开启时做法律概念扩展；highlight 开启时用【】标出命中词。
   */
  search(query, { topK = 8, paperId, expand = true, highlight = true } = {}) {
    const extras = expand ? expandQuery(query) : []
    const qt = tokenize(query + (extras.length ? ' ' + extras.join(' ') : ''))
    if (!qt.length) return []
    // 高亮词 = 原始检索词 + 扩展概念词（让扩展命中的片段也能看出关联）
    const terms = [...new Set([...queryTerms(query), ...extras])]
    let idx = this.chunkTokens.map((_, i) => i)
    if (paperId) idx = idx.filter((i) => this.chunkRefs[i].paperId === paperId)
    const scores = bm25Scores(qt, this.chunkTokens)
    return idx
      .map((i) => ({ i, score: scores[i] }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ i, score }) => {
        const ref = this.chunkRefs[i]
        const p = this.getPaper(ref.paperId)
        const chunk = p.chunks[ref.chunkIndex]
        const raw = pickSnippet(chunk, terms)
        return {
          paper_id: p.id,
          title: p.title,
          chunk_index: ref.chunkIndex,
          score: Math.round(score * 100) / 100,
          snippet: highlight ? highlightTerms(raw, terms) : raw,
        }
      })
  }

  /**
   * 相关文献推荐：以目标文献的标题与开头若干块为"查询"，对库内其他文献做 BM25 交叉打分。
   * @returns {{base: object, related: Array}|null}
   */
  related(paperId, { topK = 5 } = {}) {
    const p = this.getPaper(paperId)
    if (!p) return null
    const queryText = p.title + '\n' + p.chunks.slice(0, 8).join('\n')
    const qTokens = tokenize(queryText)
    if (!qTokens.length) return { base: { id: p.id, title: p.title }, related: [] }
    // 语料只含其他文献的块（idf 才公平）
    const chunkTokens = []
    const refs = []
    for (const x of this.data.papers) {
      if (x.id === p.id) continue
      x.chunks.forEach((c, i) => {
        chunkTokens.push(tokenize(c))
        refs.push({ paper: x, chunkIndex: i })
      })
    }
    if (!chunkTokens.length) return { base: { id: p.id, title: p.title }, related: [] }
    const scores = bm25Scores(qTokens, chunkTokens)
    const perPaper = new Map()
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] <= 0) continue
      const pid = refs[i].paper.id
      const cur = perPaper.get(pid) ?? { paper: refs[i].paper, total: 0, bestChunk: refs[i].chunkIndex, bestScore: 0 }
      cur.total += scores[i]
      if (scores[i] > cur.bestScore) {
        cur.bestScore = scores[i]
        cur.bestChunk = refs[i].chunkIndex
      }
      perPaper.set(pid, cur)
    }
    // 目标文献高频词，用于 shared 标注
    const qFreq = new Map()
    for (const t of qTokens) qFreq.set(t, (qFreq.get(t) ?? 0) + 1)
    const related = [...perPaper.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, topK)
      .map(({ paper, total, bestChunk }) => {
        const docTokens = new Set(tokenize(paper.chunks[bestChunk] + paper.title))
        const shared = [...qFreq.entries()]
          .filter(([t]) => docTokens.has(t) && t.length >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([t]) => t)
        return {
          paper_id: paper.id,
          title: paper.title,
          score: Math.round(total * 100) / 100,
          best_chunk: bestChunk,
          shared,
        }
      })
    return { base: { id: p.id, title: p.title }, related }
  }

  /** 读单篇文本窗口 */
  read(idOrPath, { offset = 0, limit = 6000 } = {}) {
    const p = this.getPaper(idOrPath) ?? this.data.papers.find((x) => x.path === resolve(idOrPath))
    if (!p) return null
    return {
      id: p.id,
      title: p.title,
      total_chars: p.text.length,
      offset,
      limit,
      text: p.text.slice(offset, offset + limit),
      has_more: offset + limit < p.text.length,
      progress: p.progress,
    }
  }

  /** 提取疑似标题行（中文序号开头的行），用于概览 */
  outline(id, maxItems = 20) {
    const p = this.getPaper(id)
    if (!p) return null
    const heads = p.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[)）]|第[一二三四五六七八九十\d]+[部分章节章]|^\d+[、.．]\s*\S/.test(l) && l.length < 60)
    return { id: p.id, title: p.title, headings: heads.slice(0, maxItems) }
  }
}

function guessTitle(text, file) {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length >= 4)
  if (first && first.length <= 60) return first
  if (first) return first.slice(0, 60)
  return basename(file, extname(file))
}
