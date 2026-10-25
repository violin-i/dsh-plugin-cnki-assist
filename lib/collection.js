// 文献库核心：分块 + BM25 检索 + 文件型存储（零外部依赖，索引在加载时内存重建）
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

/** 在文本中截取 query 首个命中词附近的片段 */
function snippetAround(text, query, width = 200) {
  const norm = text.toLowerCase()
  const key = (query.match(/[\u4e00-\u9fff]{2}/) ?? [query])[0]
  const idx = norm.indexOf(key.toLowerCase())
  if (idx < 0) return text.slice(0, width)
  const start = Math.max(0, idx - Math.floor(width / 3))
  return (start > 0 ? '…' : '') + text.slice(start, start + width) + '…'
}

// ---------- 文献库 ----------

export class Library {
  /** @param {string} dir 库目录（存放 library.json 与源文件副本不入） */
  constructor(dir, data) {
    this.dir = dir
    this.data = data ?? { version: 1, nextId: 1, papers: [] }
  }

  static async load(dir) {
    let data
    try {
      data = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8'))
    } catch {
      data = { version: 1, nextId: 1, papers: [] }
    }
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

  /** BM25 检索，可限定单篇 */
  search(query, { topK = 8, paperId } = {}) {
    const qt = tokenize(query)
    if (!qt.length) return []
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
        return {
          paper_id: p.id,
          title: p.title,
          chunk_index: ref.chunkIndex,
          score: Math.round(score * 100) / 100,
          snippet: snippetAround(p.chunks[ref.chunkIndex], query),
        }
      })
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
