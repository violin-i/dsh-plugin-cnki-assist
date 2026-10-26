// 宿主半：读取共享法学文献库（~/.dsh/law-library），以 POST 路由供浏览器面板取数
// v0.2：概念扩展检索、笔记（增删查）、阅读进度、大纲
import type { Context } from '@deepseek-ai/cordis'
import { LawLibraryStore, resolveLibraryDir } from './libstore'

export const name = 'law-workbench'

export function apply(ctx: Context, config: { libraryDir?: string } = {}): void {
  const store = new LawLibraryStore(resolveLibraryDir(config))

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const routes: { path: string; fetch: (request: Request) => Promise<Response> }[] = [
    {
      path: '/api/law-workbench/state',
      fetch: async () => json(await store.state()),
    },
    {
      path: '/api/law-workbench/search',
      fetch: async (request) => {
        const body = (await request.json().catch(() => ({}))) as {
          query?: string
          top_k?: number
          expand?: boolean
          highlight?: boolean
          paper_id?: string
        }
        if (!body.query) return json({ error: '缺少 query' }, 400)
        return json(
          await store.search(body.query, body.top_k ?? 8, {
            expand: body.expand,
            highlight: body.highlight,
            paper_id: body.paper_id,
          }),
        )
      },
    },
    {
      path: '/api/law-workbench/read',
      fetch: async (request) => {
        const body = (await request.json().catch(() => ({}))) as {
          paper_id?: string
          offset?: number
          limit?: number
        }
        if (!body.paper_id) return json({ error: '缺少 paper_id' }, 400)
        const r = await store.read(body.paper_id, body.offset ?? 0, body.limit ?? 6000)
        if (!r) return json({ error: '未找到该文献' }, 404)
        return json(r)
      },
    },
    {
      path: '/api/law-workbench/outline',
      fetch: async (request) => {
        const body = (await request.json().catch(() => ({}))) as { paper_id?: string }
        if (!body.paper_id) return json({ error: '缺少 paper_id' }, 400)
        const r = await store.outline(body.paper_id)
        if (!r) return json({ error: '未找到该文献' }, 404)
        return json(r)
      },
    },
    {
      path: '/api/law-workbench/notes',
      fetch: async (request) => {
        const body = (await request.json().catch(() => ({}))) as { paper_id?: string }
        return json(await store.listNotes(body.paper_id))
      },
    },
    {
      path: '/api/law-workbench/note',
      fetch: async (request) => {
        const body = (await request.json().catch(() => ({}))) as {
          action?: 'add' | 'remove'
          paper_id?: string
          quote?: string
          comment?: string
          chunk_index?: number | null
          note_id?: string
        }
        if (body.action === 'remove') {
          if (!body.paper_id || !body.note_id) return json({ error: '删除笔记需要 paper_id 与 note_id' }, 400)
          return json(await store.removeNote(body.paper_id, body.note_id))
        }
        if (!body.paper_id) return json({ error: '添加笔记需要 paper_id' }, 400)
        const r = await store.addNote(body.paper_id, {
          quote: body.quote,
          comment: body.comment,
          chunk_index: body.chunk_index ?? null,
        })
        if ('error' in r) return json(r, 400)
        return json(r)
      },
    },
    {
      path: '/api/law-workbench/progress',
      fetch: async (request) => {
        const body = (await request.json().catch(() => ({}))) as { paper_id?: string; offset?: number }
        if (!body.paper_id) return json({ error: '缺少 paper_id' }, 400)
        const r = await store.setProgress(body.paper_id, body.offset ?? 0)
        if ('error' in r) return json(r, 404)
        return json(r)
      },
    },
  ]

  // connection.fetch.register 由 dsh-context 验证过的标准接缝；face 缺席时静默跳过（面板显示"无数据"）
  const connection = ctx.get('connection') as
    | {
        fetch?: {
          register?: (route: {
            path: string
            methods: readonly string[]
            requestBody: 'buffered'
            fetch: (request: Request) => Response | Promise<Response>
          }) => () => void
        }
      }
    | undefined

  const register = connection?.fetch?.register?.bind(connection.fetch)
  if (typeof register === 'function') {
    for (const route of routes) {
      try {
        ctx.effect(
          () => register({ path: route.path, methods: ['POST'], requestBody: 'buffered', fetch: route.fetch }),
          `law-workbench: ${route.path}`,
        )
      } catch {
        // 注册失败不致命：其他路由继续
      }
    }
  } else {
    ctx.logger?.warn?.('[law-workbench] connection.fetch.register 不可用，面板将无数据')
  }
}
