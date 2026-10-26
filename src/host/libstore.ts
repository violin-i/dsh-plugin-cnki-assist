// 共享文献库只读+笔记/进度回写访问（~/.dsh/law-library，存储格式 v2，兼容 v1）
// 检索纯函数（分词/概念表/扩展/高亮/片段）直接复用本包 lib/collection.js——合并后单一事实源，无需两侧同步
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tokenize, expandQuery, highlightTerms, queryTerms, pickSnippet } from '../../lib/collection.js'

export interface LibraryNote {
  id: string
  quote: string
  comment: string
  chunk_index: number | null
  created_at: string
}

export interface LibraryProgress {
  offset: number
  updated_at: string
}

export interface LibraryPaper {
  id: string
  title: string
  path: string
  pages?: number | null
  addedAt: string
  text: string
  chunks: string[]
  notes?: LibraryNote[]
  progress?: LibraryProgress | null
}

export interface LibraryData {
  version: number
  nextId: number
  nextNoteId?: number
  papers: LibraryPaper[]
}

// ---------- 检索与高亮纯函数见 lib/collection.js（tokenize/LEGAL_CONCEPTS/expandQuery/highlightTerms/queryTerms/pickSnippet） ----------

// ---------- 存储 ----------

export class LawLibraryStore {
  private data: LibraryData | null = null
  private loadedAt = 0

  constructor(readonly dir: string) {}

  async load(force = false): Promise<LibraryData> {
    if (this.data && !force && Date.now() - this.loadedAt < 2000) return this.data
    try {
      const raw = await readFile(join(this.dir, 'library.json'), 'utf8')
      this.data = JSON.parse(raw) as LibraryData
    } catch {
      this.data = { version: 2, nextId: 1, papers: [] }
    }
    // v1 兼容：补默认字段
    for (const p of this.data.papers) {
      if (!Array.isArray(p.notes)) p.notes = []
      if (p.progress === undefined) p.progress = null
    }
    this.loadedAt = Date.now()
    return this.data
  }

  /** 回写前强制重读，减小与 cnki-assist 工具侧并发写互覆的窗口 */
  private async mutate<T>(fn: (lib: LibraryData) => T | Promise<T>): Promise<T> {
    const lib = await this.load(true)
    const result = await fn(lib)
    lib.version = 2
    if (!lib.nextNoteId) lib.nextNoteId = 1
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, 'library.json'), JSON.stringify(lib), 'utf8')
    return result
  }

  async state() {
    const lib = await this.load(true)
    return {
      library_dir: this.dir,
      count: lib.papers.length,
      papers: lib.papers.map((p) => ({
        id: p.id,
        title: p.title,
        pages: p.pages ?? null,
        chars: p.text.length,
        chunks: p.chunks.length,
        added_at: p.addedAt,
        notes: (p.notes ?? []).length,
        progress: p.progress
          ? { offset: p.progress.offset, pct: Math.round((p.progress.offset / Math.max(1, p.text.length)) * 100) }
          : null,
      })),
    }
  }

  async search(query: string, topK = 8, opts: { expand?: boolean; highlight?: boolean; paper_id?: string } = {}) {
    const lib = await this.load()
    const expand = opts.expand !== false
    const highlight = opts.highlight !== false
    const extras = expand ? expandQuery(query) : []
    const qt = tokenize(query + (extras.length ? ' ' + extras.join(' ') : ''))
    if (!qt.length) return { expanded: extras, results: [] }
    // 高亮词 = 原始检索词 + 扩展概念词（与 cnki-assist 行为一致）
    const terms = [...new Set([...queryTerms(query), ...extras])]
    const chunkTokens: string[][] = []
    const refs: { paper: LibraryPaper; chunkIndex: number }[] = []
    for (const p of lib.papers) {
      if (opts.paper_id && p.id !== opts.paper_id && p.title !== opts.paper_id) continue
      p.chunks.forEach((_, i) => {
        chunkTokens.push(tokenize(p.chunks[i]))
        refs.push({ paper: p, chunkIndex: i })
      })
    }
    const N = chunkTokens.length
    const avgLen = chunkTokens.reduce((s, t) => s + t.length, 0) / (N || 1) || 1
    const df = new Map<string, number>()
    for (const tokens of chunkTokens) {
      for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1)
    }
    const k1 = 1.5
    const b = 0.75
    const scores = new Array(N).fill(0)
    for (const q of new Set(qt)) {
      const d = df.get(q)
      if (!d) continue
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5))
      for (let i = 0; i < N; i++) {
        let tf = 0
        for (const t of chunkTokens[i]) if (t === q) tf++
        if (!tf) continue
        scores[i] += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * chunkTokens[i].length) / avgLen))
      }
    }
    return {
      expanded: extras,
      results: scores
        .map((score, i) => ({ i, score }))
        .filter((x) => x.score > 0)
        .sort((a, b2) => b2.score - a.score)
        .slice(0, topK)
        .map(({ i, score }) => {
          const raw = pickSnippet(refs[i].paper.chunks[refs[i].chunkIndex], terms)
          return {
            paper_id: refs[i].paper.id,
            title: refs[i].paper.title,
            chunk_index: refs[i].chunkIndex,
            score: Math.round(score * 100) / 100,
            snippet: highlight ? highlightTerms(raw, terms) : raw,
          }
        }),
    }
  }

  async read(paperId: string, offset = 0, limit = 6000) {
    const lib = await this.load()
    const p = lib.papers.find((x) => x.id === paperId || x.title === paperId)
    if (!p) return null
    return {
      id: p.id,
      title: p.title,
      total_chars: p.text.length,
      offset,
      limit,
      text: p.text.slice(offset, offset + limit),
      has_more: offset + limit < p.text.length,
      progress: p.progress ?? null,
    }
  }

  async outline(paperId: string, maxItems = 30) {
    const lib = await this.load()
    const p = lib.papers.find((x) => x.id === paperId || x.title === paperId)
    if (!p) return null
    const heads = p.text
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          /^[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[)）]|第[一二三四五六七八九十\d]+[部分章节章]|^\d+[、.．]\s*\S/.test(l) &&
          l.length < 60,
      )
    return { id: p.id, title: p.title, headings: heads.slice(0, maxItems) }
  }

  // ---------- 笔记（回写共享库） ----------

  async addNote(paperId: string, fields: { quote?: string; comment?: string; chunk_index?: number | null }) {
    if (!fields.comment || !String(fields.comment).trim()) return { error: '批注内容不能为空' } as const
    return this.mutate((lib) => {
      const p = lib.papers.find((x) => x.id === paperId || x.title === paperId)
      if (!p) return { error: '未找到该文献' } as const
      if (!Array.isArray(p.notes)) p.notes = []
      if (!lib.nextNoteId) lib.nextNoteId = 1
      const note: LibraryNote = {
        id: 'n' + lib.nextNoteId++,
        quote: String(fields.quote ?? '').slice(0, 500),
        comment: String(fields.comment).slice(0, 2000),
        chunk_index: Number.isInteger(fields.chunk_index) ? (fields.chunk_index as number) : null,
        created_at: new Date().toISOString(),
      }
      p.notes.push(note)
      return { note, paper: { id: p.id, title: p.title } } as const
    })
  }

  async removeNote(paperId: string, noteId: string) {
    return this.mutate((lib) => {
      const p = lib.papers.find((x) => x.id === paperId || x.title === paperId)
      if (!p || !Array.isArray(p.notes)) return { removed: false } as const
      const i = p.notes.findIndex((n) => n.id === noteId)
      if (i < 0) return { removed: false } as const
      p.notes.splice(i, 1)
      return { removed: true } as const
    })
  }

  async listNotes(paperId?: string) {
    const lib = await this.load()
    const papers = paperId ? lib.papers.filter((p) => p.id === paperId || p.title === paperId) : lib.papers
    const out: (LibraryNote & { paper_id: string; title: string })[] = []
    for (const p of papers) {
      for (const n of p.notes ?? []) out.push({ paper_id: p.id, title: p.title, ...n })
    }
    return { notes: out }
  }

  // ---------- 阅读进度（回写共享库） ----------

  async setProgress(paperId: string, offset: number) {
    return this.mutate((lib) => {
      const p = lib.papers.find((x) => x.id === paperId || x.title === paperId)
      if (!p) return { error: '未找到该文献' } as const
      const off = Math.max(0, Math.min(Number(offset) || 0, p.text.length))
      p.progress = { offset: off, updated_at: new Date().toISOString() }
      return { progress: p.progress } as const
    })
  }
}

export function resolveLibraryDir(config: { libraryDir?: string } | undefined): string {
  return config?.libraryDir || join(homedir(), '.dsh', 'law-library')
}
