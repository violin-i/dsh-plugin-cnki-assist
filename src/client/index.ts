// 浏览器半：在右侧停靠栏注册"工作台"标签页 + React 面板
// v0.2：命中词高亮、阅读进度续读、大纲视图、笔记（摘录+批注）
import { createElement as h, useCallback, useEffect, useState } from 'react'

const TAB_ID = 'dsh-plugin-law-workbench'
const TAB_KIND = 'law-workbench'

// ---------- 最小结构类型（浏览器 bundle 不引用 @deepseek-ai/* 值） ----------

interface SlotsFace {
  inject(name: string, setup: () => unknown): () => void
  register(definition: { name: string; key: string }, component: unknown): () => void
}

interface TabsFace {
  register(definition: {
    id: string
    kind: string
    title: () => string
    guide?: { order: number; title: () => string; description?: () => string; icon?: unknown }[]
  }): () => void
}

interface ClientCtx {
  inject(deps: string[], callback: (ctx: ClientCtx) => (() => void) | undefined): unknown
}

// ---------- 图标 ----------

function LawIcon(props: { className?: string }): unknown {
  return h(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, ...props },
    h('path', { d: 'M12 3v18M5 21h14M12 5l-6 2 0 0c0 2.2 1.3 4 3 4s3-1.8 3-4z' }),
    h('path', { d: 'M12 5l6 2c0 2.2-1.3 4-3 4s-3-1.8-3-4z', transform: 'translate(6,0)' }),
  )
}

// ---------- 数据访问 ----------

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

interface PaperProgress {
  offset: number
  pct: number
}

interface PaperMeta {
  id: string
  title: string
  pages: number | null
  chars: number
  chunks: number
  added_at: string
  notes: number
  progress: PaperProgress | null
}

interface StateResp {
  library_dir: string
  count: number
  papers: PaperMeta[]
}

interface SearchHit {
  paper_id: string
  title: string
  chunk_index: number
  score: number
  snippet: string
}

interface SearchResp {
  expanded: string[]
  results: SearchHit[]
}

interface ReadResp {
  id: string
  title: string
  total_chars: number
  offset: number
  limit: number
  text: string
  has_more: boolean
  progress: { offset: number; updated_at: string } | null
}

interface NoteItem {
  id: string
  paper_id: string
  title: string
  quote: string
  comment: string
  chunk_index: number | null
  created_at: string
}

// ---------- 命中词高亮渲染：把服务端【】标记转成样式 span ----------

function Snippet(props: { text: string }): unknown {
  const { text } = props
  const parts: unknown[] = []
  const re = /【([^】]+)】/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(h('span', { className: 'lwb-mark', key: k++ }, m[1]))
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return h('div', { className: 'lwb-hit-snippet' }, parts)
}

// ---------- 样式（深色友好，跟随系统配色） ----------

const css = `
.lwb-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; color: inherit; font-size: 13px; }
.lwb-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(128,128,128,.25); }
.lwb-title { font-weight: 600; flex: 1; }
.lwb-sub { opacity: .65; font-size: 12px; }
.lwb-btn { background: transparent; border: 1px solid rgba(128,128,128,.4); border-radius: 6px; color: inherit; padding: 3px 10px; cursor: pointer; font-size: 12px; }
.lwb-btn:hover { border-color: currentColor; }
.lwb-btn:disabled { opacity: .4; cursor: default; }
.lwb-btn-on { background: rgba(77,107,254,.15); border-color: rgba(77,107,254,.6); }
.lwb-search { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid rgba(128,128,128,.25); }
.lwb-input { flex: 1; background: rgba(128,128,128,.12); border: 1px solid rgba(128,128,128,.35); border-radius: 6px; color: inherit; padding: 5px 9px; font-size: 13px; outline: none; }
.lwb-input:focus { border-color: rgba(77,107,254,.8); }
.lwb-body { flex: 1; overflow-y: auto; padding: 8px 12px 16px; }
.lwb-card { border: 1px solid rgba(128,128,128,.25); border-radius: 8px; padding: 9px 11px; margin-bottom: 8px; cursor: pointer; }
.lwb-card:hover { border-color: rgba(77,107,254,.6); background: rgba(128,128,128,.07); }
.lwb-card-title { font-weight: 550; margin-bottom: 4px; line-height: 1.45; }
.lwb-card-meta { opacity: .6; font-size: 11.5px; }
.lwb-resume { color: #4d6bfe; opacity: 1; }
.lwb-hit { border-left: 2px solid rgba(77,107,254,.55); padding: 6px 10px; margin-bottom: 10px; }
.lwb-hit-title { font-weight: 550; cursor: pointer; margin-bottom: 3px; }
.lwb-hit-title:hover { color: #4d6bfe; }
.lwb-hit-score { opacity: .55; font-size: 11px; margin-left: 6px; font-weight: 400; }
.lwb-hit-snippet { opacity: .8; font-size: 12px; line-height: 1.55; }
.lwb-mark { background: rgba(77,107,254,.22); border-radius: 3px; padding: 0 1px; }
.lwb-reader-text { white-space: pre-wrap; line-height: 1.75; font-size: 13px; padding: 4px 2px 12px; }
.lwb-progress { height: 3px; background: rgba(128,128,128,.2); border-radius: 2px; margin: 6px 0 2px; overflow: hidden; }
.lwb-progress > div { height: 100%; background: #4d6bfe; border-radius: 2px; }
.lwb-toolbar { display: flex; gap: 6px; margin: 8px 0 10px; flex-wrap: wrap; }
.lwb-outline-list { margin: 0 0 10px; padding: 6px 10px; border: 1px solid rgba(128,128,128,.2); border-radius: 6px; }
.lwb-outline-list > div { padding: 2px 0; opacity: .85; font-size: 12px; }
.lwb-note { border: 1px solid rgba(128,128,128,.25); border-left: 2px solid rgba(224,150,60,.65); border-radius: 6px; padding: 7px 9px; margin-bottom: 7px; }
.lwb-note-head { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; font-size: 11px; opacity: .6; }
.lwb-note-del { margin-left: auto; background: none; border: none; color: inherit; opacity: .5; cursor: pointer; font-size: 11px; padding: 0; }
.lwb-note-del:hover { opacity: 1; color: #e5484d; }
.lwb-note-quote { opacity: .75; font-size: 12px; margin-bottom: 3px; line-height: 1.5; }
.lwb-note-comment { font-size: 12.5px; line-height: 1.55; }
.lwb-composer { border: 1px solid rgba(77,107,254,.5); border-radius: 8px; padding: 9px 10px; margin-bottom: 10px; }
.lwb-composer textarea { width: 100%; box-sizing: border-box; background: rgba(128,128,128,.12); border: 1px solid rgba(128,128,128,.35); border-radius: 6px; color: inherit; padding: 5px 8px; font-size: 12px; font-family: inherit; outline: none; resize: vertical; margin-bottom: 6px; }
.lwb-composer textarea:focus { border-color: rgba(77,107,254,.8); }
.lwb-pager { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid rgba(128,128,128,.25); }
.lwb-empty { opacity: .7; padding: 28px 8px; text-align: center; line-height: 1.8; }
.lwb-err { color: #e5484d; padding: 12px; line-height: 1.6; }
`

let cssSeated = false
function ensureCss(): void {
  if (cssSeated || typeof document === 'undefined') return
  if (!document.querySelector('style[data-plugin-css="dsh-plugin-law-workbench/base"]')) {
    const tag = document.createElement('style')
    tag.dataset.pluginCss = 'dsh-plugin-law-workbench/base'
    tag.textContent = css
    document.head.appendChild(tag)
  }
  cssSeated = true
}

// ---------- 面板 ----------

const READ_LIMIT = 3000

function Panel(): unknown {
  useEffect(ensureCss, [])
  const [state, setState] = useState<StateResp | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [reader, setReader] = useState<ReadResp | null>(null)
  const [notes, setNotes] = useState<NoteItem[]>([])
  const [showOutline, setShowOutline] = useState(false)
  const [outline, setOutline] = useState<string[] | null>(null)
  const [showNotes, setShowNotes] = useState(false)
  const [composer, setComposer] = useState<{ quote: string; comment: string } | null>(null)
  const [selText, setSelText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setState(await post<StateResp>('/api/law-workbench/state', {}))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadNotes = useCallback(async (paperId: string) => {
    try {
      const r = await post<{ notes: NoteItem[] }>('/api/law-workbench/notes', { paper_id: paperId })
      setNotes(r.notes)
    } catch {
      setNotes([])
    }
  }, [])

  const openPaper = useCallback(
    async (paperId: string, offset = 0) => {
      setBusy(true)
      setError('')
      try {
        const r = await post<ReadResp>('/api/law-workbench/read', {
          paper_id: paperId,
          offset,
          limit: READ_LIMIT,
        })
        setReader(r)
        setResults(null)
        setShowOutline(false)
        setOutline(null)
        setShowNotes(false)
        setComposer(null)
        setSelText('')
        void loadNotes(r.id)
        // 进度回写：把本次阅读位置存入共享库（失败不打扰阅读）
        void post('/api/law-workbench/progress', { paper_id: r.id, offset }).catch(() => {})
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [loadNotes],
  )

  const doSearch = useCallback(async () => {
    if (!query.trim()) return
    setBusy(true)
    setError('')
    setReader(null)
    try {
      const r = await post<SearchResp>('/api/law-workbench/search', { query, top_k: 10 })
      setResults(r.results)
      setExpanded(r.expanded ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [query])

  const toggleOutline = useCallback(async () => {
    if (!reader) return
    const next = !showOutline
    setShowOutline(next)
    if (next && outline === null) {
      try {
        const r = await post<{ headings: string[] }>('/api/law-workbench/outline', { paper_id: reader.id })
        setOutline(r.headings)
      } catch {
        setOutline([])
      }
    }
  }, [reader, showOutline, outline])

  const toggleNotes = useCallback(
    async (open?: boolean) => {
      if (!reader) return
      const next = open ?? !showNotes
      setShowNotes(next)
      if (next) void loadNotes(reader.id)
    },
    [reader, showNotes, loadNotes],
  )

  const captureSelection = useCallback(() => {
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection()?.toString() ?? '' : ''
    if (sel.trim()) setSelText(sel.trim().slice(0, 500))
  }, [])

  const startComposer = useCallback(() => {
    setComposer({ quote: selText, comment: '' })
    setShowNotes(true)
  }, [selText])

  const saveNote = useCallback(async () => {
    if (!reader || !composer || !composer.comment.trim()) return
    try {
      await post('/api/law-workbench/note', {
        paper_id: reader.id,
        quote: composer.quote,
        comment: composer.comment.trim(),
      })
      setComposer(null)
      setSelText('')
      void loadNotes(reader.id)
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [reader, composer, loadNotes, refresh])

  const deleteNote = useCallback(
    async (noteId: string) => {
      if (!reader) return
      try {
        await post('/api/law-workbench/note', { action: 'remove', paper_id: reader.id, note_id: noteId })
        void loadNotes(reader.id)
        void refresh()
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [reader, loadNotes, refresh],
  )

  const readerPct = reader ? Math.round(((reader.offset + reader.text.length) / Math.max(1, reader.total_chars)) * 100) : 0

  return h(
    'div',
    { className: 'lwb-root' },
    h(
      'div',
      { className: 'lwb-head' },
      h(LawIcon, null),
      h('span', { className: 'lwb-title' }, '工作台'),
      state ? h('span', { className: 'lwb-sub' }, `${state.count} 篇`) : null,
      h('button', { className: 'lwb-btn', onClick: () => void refresh(), disabled: busy }, '刷新'),
    ),
    reader
      ? null
      : h(
          'div',
          { className: 'lwb-search' },
          h('input', {
            className: 'lwb-input',
            placeholder: '检索文献库（如：效力性强制性规定）',
            value: query,
            onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
            onKeyDown: (e: { key: string }) => {
              if (e.key === 'Enter') void doSearch()
            },
          }),
          h('button', { className: 'lwb-btn', onClick: () => void doSearch(), disabled: busy }, '检索'),
        ),
    h(
      'div',
      {
        className: 'lwb-body',
        onMouseUp: reader ? captureSelection : undefined,
      },
      error ? h('div', { className: 'lwb-err' }, `加载失败：${error}`) : null,
      reader
        ? h(
            'div',
            null,
            h('div', { className: 'lwb-card-title' }, reader.title),
            h(
              'div',
              { className: 'lwb-card-meta' },
              `${reader.total_chars} 字 · 已读 ${readerPct}%`,
            ),
            h('div', { className: 'lwb-progress' }, h('div', { style: { width: `${readerPct}%` } })),
            h(
              'div',
              { className: 'lwb-toolbar' },
              h(
                'button',
                { className: `lwb-btn${showOutline ? ' lwb-btn-on' : ''}`, onClick: () => void toggleOutline() },
                '大纲',
              ),
              h(
                'button',
                {
                  className: `lwb-btn${showNotes ? ' lwb-btn-on' : ''}`,
                  onClick: () => void toggleNotes(),
                },
                `笔记${notes.length ? ` ${notes.length}` : ''}`,
              ),
              h('button', { className: 'lwb-btn', onClick: startComposer, disabled: !selText.trim() }, '摘录选中'),
            ),
            showOutline
              ? h(
                  'div',
                  { className: 'lwb-outline-list' },
                  outline === null
                    ? h('div', null, '解析大纲中…')
                    : outline.length
                      ? outline.map((hd, i) => h('div', { key: i }, hd))
                      : h('div', null, '未识别出章节标题（依赖中文序号行，部分 PDF 无此结构）'),
                )
              : null,
            showNotes
              ? h(
                  'div',
                  null,
                  composer
                    ? h(
                        'div',
                        { className: 'lwb-composer' },
                        h('textarea', {
                          rows: 2,
                          placeholder: '摘录（可在正文划选后点"摘录选中"）',
                          value: composer.quote,
                          onChange: (e: { target: { value: string } }) =>
                            setComposer({ ...composer, quote: e.target.value }),
                        }),
                        h('textarea', {
                          rows: 3,
                          placeholder: '批注：这条摘录说明了什么、支撑哪个论点',
                          value: composer.comment,
                          onChange: (e: { target: { value: string } }) =>
                            setComposer({ ...composer, comment: e.target.value }),
                        }),
                        h(
                          'div',
                          { className: 'lwb-toolbar', style: { margin: '0' } },
                          h(
                            'button',
                            {
                              className: 'lwb-btn lwb-btn-on',
                              disabled: !composer.comment.trim() || busy,
                              onClick: () => void saveNote(),
                            },
                            '保存笔记',
                          ),
                          h('button', { className: 'lwb-btn', onClick: () => setComposer(null) }, '取消'),
                        ),
                      )
                    : h(
                        'div',
                        { className: 'lwb-toolbar' },
                        h(
                          'span',
                          { className: 'lwb-sub', style: { alignSelf: 'center' } },
                          selText.trim() ? '已捕获选中文字，点"摘录选中"建笔记' : '在正文划选文字后可一键摘录',
                        ),
                      ),
                  notes.length
                    ? notes.map((n) =>
                        h(
                          'div',
                          { className: 'lwb-note', key: n.id },
                          h(
                            'div',
                            { className: 'lwb-note-head' },
                            h('span', null, n.id),
                            n.chunk_index != null ? h('span', null, `#${n.chunk_index}`) : null,
                            h('span', null, (n.created_at ?? '').slice(0, 10)),
                            h(
                              'button',
                              { className: 'lwb-note-del', onClick: () => void deleteNote(n.id) },
                              '删除',
                            ),
                          ),
                          n.quote ? h('div', { className: 'lwb-note-quote' }, n.quote) : null,
                          h('div', { className: 'lwb-note-comment' }, n.comment),
                        ),
                      )
                    : composer
                      ? null
                      : h('div', { className: 'lwb-empty', style: { padding: '12px 4px' } }, '本篇还没有笔记'),
                )
              : null,
            h('div', { className: 'lwb-reader-text' }, reader.text),
          )
        : results
          ? results.length === 0
            ? h('div', { className: 'lwb-empty' }, '无命中。换个检索词试试。')
            : h(
                'div',
                null,
                expanded.length
                  ? h(
                      'div',
                      { className: 'lwb-card-meta', style: { marginBottom: '8px' } },
                      `已扩展概念词：${expanded.join('、')}`,
                    )
                  : null,
                results.map((r) =>
                  h(
                    'div',
                    { className: 'lwb-hit', key: `${r.paper_id}-${r.chunk_index}` },
                    h(
                      'div',
                      {
                        className: 'lwb-hit-title',
                        onClick: () => void openPaper(r.paper_id),
                      },
                      r.title,
                      h('span', { className: 'lwb-hit-score' }, `score ${r.score}`),
                    ),
                    h(Snippet, { text: r.snippet }),
                  ),
                ),
              )
          : state
            ? state.count === 0
              ? h(
                  'div',
                  { className: 'lwb-empty' },
                  '文献库为空。',
                  h('br'),
                  '在对话里说"把 D:\\论文 文件夹入库"，',
                  h('br'),
                  '或用 law_lib_add 工具添加 PDF。',
                )
              : state.papers.map((p) =>
                  h(
                    'div',
                    {
                      className: 'lwb-card',
                      key: p.id,
                      onClick: () => void openPaper(p.id, p.progress?.offset ?? 0),
                    },
                    h('div', { className: 'lwb-card-title' }, p.title),
                    h(
                      'div',
                      { className: 'lwb-card-meta' },
                      `${p.pages ? `${p.pages} 页 · ` : ''}${p.chars} 字 · ${p.chunks} 块` +
                        `${p.notes ? ` · ${p.notes} 笔记` : ''}`,
                      p.progress
                        ? h(
                            'span',
                            { className: 'lwb-resume' },
                            ` · 读到 ${p.progress.pct}%，点击续读`,
                          )
                        : null,
                    ),
                  ),
                )
            : !error
              ? h('div', { className: 'lwb-empty' }, busy ? '加载中…' : '')
              : null,
    ),
    reader
      ? h(
          'div',
          { className: 'lwb-pager' },
          h('button', { className: 'lwb-btn', onClick: () => setReader(null) }, '← 返回'),
          h(
            'span',
            { className: 'lwb-sub' },
            `${reader.offset + 1}-${Math.min(reader.offset + reader.limit, reader.total_chars)} / ${reader.total_chars}`,
          ),
          h(
            'button',
            {
              className: 'lwb-btn',
              disabled: reader.offset === 0 || busy,
              onClick: () => void openPaper(reader.id, Math.max(0, reader.offset - READ_LIMIT)),
            },
            '上一段',
          ),
          h(
            'button',
            {
              className: 'lwb-btn',
              disabled: !reader.has_more || busy,
              onClick: () => void openPaper(reader.id, reader.offset + READ_LIMIT),
            },
            '下一段',
          ),
        )
      : null,
  )
}

// ---------- 注册 ----------

export const name = 'law-workbench-client'

/** 面板组件（导出仅供测试渲染验证） */
export const __Panel = Panel

export function apply(ctx: ClientCtx): void {
  ctx.inject(['sidebarRightTabs'], (raw: ClientCtx & { sidebarRightTabs?: TabsFace; slots?: SlotsFace }) => {
    const disposers: (() => void)[] = []
    const own = (dispose: unknown): void => {
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
    try {
      const tabs = raw.sidebarRightTabs
      if (tabs !== undefined && typeof tabs.register === 'function') {
        own(
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => '工作台',
            guide: [
              {
                order: 30,
                title: () => '工作台',
                description: () => '本地文献库：文献列表 / 全文检索 / 阅读 / 笔记',
                icon: LawIcon,
              },
            ],
          }),
        )
      }
      const slots = raw.slots
      if (slots !== undefined && typeof slots.inject === 'function') {
        own(
          slots.inject('sidebar.right.pane.tab', () =>
            slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Panel),
          ),
        )
      }
    } catch {
      for (const dispose of disposers) dispose()
      return undefined
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
