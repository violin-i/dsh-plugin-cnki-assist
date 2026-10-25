// 法学文献库工作台：本地文献入库、检索、阅读、引注（本地 BM25，零网络、零密钥）
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Library } from './lib/collection.js'
import { formatCitation } from './lib/citation.js'

export const name = 'law-library'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const libraryDir = config.libraryDir || join(homedir(), '.dsh', 'law-library')
  let libPromise = null
  const lib = () => (libPromise ??= Library.load(libraryDir))

  const notFound = (what) => new Error(`未找到文献：${what}。可先用 law_lib_list 查看库内文献。`)

  ctx.tools.register(
    defineTool({
      name: 'law_lib_add',
      description:
        '把本地文献文件加入法学文献库（支持 .pdf/.txt/.md，可传文件或目录）。' +
        'PDF 自动提取文本（需有文本层，扫描版会被跳过并提示 OCR）。入库后即可用 law_lib_search / law_lib_read / law_lib_citation。' +
        '学生把知网手动下载的 PDF 放进一个文件夹后，把路径传给本工具即可批量入库。相同文件（哈希相同）自动去重。',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '文件或目录的绝对路径列表',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            added: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  pages: { type: 'number' },
                  chars: { type: 'number', required: true },
                  chunks: { type: 'number', required: true },
                  path: { type: 'string' },
                },
                additionalProperties: false,
              },
              required: true,
            },
            skipped: {
              type: 'array',
              items: {
                type: 'object',
                properties: { path: { type: 'string', required: true }, reason: { type: 'string', required: true } },
                additionalProperties: false,
              },
              required: true,
            },
            library_dir: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_a, v) => [
          {
            type: 'text',
            text:
              `入库 ${v.added.length} 篇` +
              (v.skipped.length ? `，跳过 ${v.skipped.length} 个（${v.skipped.map((s) => s.reason).slice(0, 2).join('；')}）` : '') +
              `\n` +
              v.added.map((p) => `· [${p.id}] ${p.title}（${p.pages ? p.pages + '页/' : ''}${p.chunks}块）`).join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const library = await lib()
        return { ...(await library.addPaths(args.paths)), library_dir: libraryDir }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_list',
      description: '列出法学文献库中的全部文献（id、标题、页数、块数）。做总结/对比/综述前先调用本工具掌握库内有什么。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            count: { type: 'number', required: true },
            papers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  pages: { type: 'number' },
                  chars: { type: 'number', required: true },
                  chunks: { type: 'number', required: true },
                  added_at: { type: 'string' },
                },
                additionalProperties: false,
              },
              required: true,
            },
            library_dir: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_a, v) => [
          {
            type: 'text',
            text: v.papers.length
              ? `库内 ${v.count} 篇：\n` + v.papers.map((p) => `· [${p.id}] ${p.title}（${p.chars}字/${p.chunks}块）`).join('\n')
              : '文献库为空。请先让学生把 PDF 放入文件夹，然后调用 law_lib_add。',
          },
        ],
      },
      async execute() {
        const library = await lib()
        return { count: library.data.papers.length, papers: library.listPapers(), library_dir: libraryDir }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_search',
      description:
        '在法学文献库内做 BM25 全文检索，返回最相关的文块（含出处与片段）。' +
        '用于：定位某个论点的原文位置、跨文献比较同一问题、综述时按主题取材。检索词用中文自然词组效果最好（如"效力性强制性规定的识别标准"）。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词' },
        top_k: { type: 'number', description: '返回块数，默认 8' },
        paper_id: { type: 'string', description: '可选：只在指定文献内检索' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  paper_id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  chunk_index: { type: 'number', required: true },
                  score: { type: 'number', required: true },
                  snippet: { type: 'string', required: true },
                },
                additionalProperties: false,
              },
              required: true,
            },
          },
          additionalProperties: false,
        },
        render: (_a, v) => [
          {
            type: 'text',
            text: v.results.length
              ? v.results.map((r) => `· [${r.paper_id}]《${r.title}》#${r.chunk_index} (score ${r.score})\n  ${r.snippet}`).join('\n\n')
              : '无命中块。可尝试更换检索词或检查文献是否已入库。',
          },
        ],
      },
      async execute(args) {
        const library = await lib()
        return { results: library.search(args.query, { topK: args.top_k ?? 8, paperId: args.paper_id }) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_read',
      description:
        '读取库内一篇文献的全文或大纲。part=outline 返回章节标题列表（先看结构）；part=text 按 offset/limit 窗口读正文（每次默认 6000 字，滚动读取）。' +
        '做单篇精读总结时：先 outline 再按窗口通读；只需定位论点时优先用 law_lib_search。',
      parameters: {
        paper_id: { type: 'string', required: true, description: '文献 id 或标题' },
        part: { type: 'string', enum: ['text', 'outline'], description: '默认 text' },
        offset: { type: 'number', description: '正文起始字符位置，默认 0' },
        limit: { type: 'number', description: '本次读取字符数上限，默认 6000' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            kind: { type: 'string', enum: ['text', 'outline'], required: true },
            total_chars: { type: 'number' },
            offset: { type: 'number' },
            limit: { type: 'number' },
            has_more: { type: 'boolean' },
            text: { type: 'string' },
            headings: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        render: (_a, v) => [
          {
            type: 'text',
            text:
              v.kind === 'outline'
                ? `《${v.title}》大纲：\n` + (v.headings ?? []).map((h) => '· ' + h).join('\n')
                : `《${v.title}》正文 [${v.offset}, ${v.offset + (v.text ?? '').length}) / ${v.total_chars}` + (v.has_more ? '（未完）' : '（完）') + `\n${v.text}`,
          },
        ],
      },
      async execute(args) {
        const library = await lib()
        if (args.part === 'outline') {
          const o = library.outline(args.paper_id)
          if (!o) throw notFound(args.paper_id)
          return { id: o.id, title: o.title, kind: 'outline', headings: o.headings }
        }
        const r = library.read(args.paper_id, { offset: args.offset ?? 0, limit: args.limit ?? 6000 })
        if (!r) throw notFound(args.paper_id)
        return { ...r, kind: 'text' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_citation',
      description:
        '生成《法学引注手册》格式的引注（也支持 GB/T 7714）。给 paper_id 时自动带出库内标题；' +
        '作者/期刊/年份/期号/页码等元数据 PDF 里通常没有，请从上下文（如 cnki_parse_export 的题录）补全后再调用。' +
        '缺失字段会以〔待补〕标出，提醒用户核对原文。',
      parameters: {
        paper_id: { type: 'string', description: '库内文献 id（带出标题）' },
        style: { type: 'string', enum: ['法学引注手册', 'GB/T 7714'], description: '默认 法学引注手册' },
        type: { type: 'string', enum: ['journal', 'thesis', 'book', 'web'], description: '文献类型，默认 journal' },
        authors: { type: 'array', items: { type: 'string' }, description: '作者列表' },
        title: { type: 'string' },
        journal: { type: 'string' },
        year: { type: 'string' },
        issue: { type: 'string' },
        page: { type: 'string', description: '引注页码，如 45 或 45-58' },
        university: { type: 'string', description: '学位论文用' },
        degree: { type: 'string', description: '博士/硕士，默认博士' },
        publisher: { type: 'string' },
        site: { type: 'string' },
        url: { type: 'string' },
        date: { type: 'string' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            citation: { type: 'string', required: true },
            missing_fields: { type: 'number', required: true },
          },
          additionalProperties: false,
        },
        render: (_a, v) => [
          { type: 'text', text: v.citation + (v.missing_fields ? `\n（${v.missing_fields} 个字段待补）` : '') },
        ],
      },
      async execute(args) {
        const library = await lib()
        const fields = { ...args }
        delete fields.style
        if (args.paper_id) {
          const p = library.getPaper(args.paper_id)
          if (p) fields.title = fields.title || p.title
        }
        return formatCitation(fields, args.style ?? '法学引注手册')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_remove',
      description: '从文献库移除一篇文献（按 id、标题或原路径）。',
      parameters: {
        paper: { type: 'string', required: true, description: '文献 id / 标题 / 原路径' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            removed: { type: 'boolean', required: true },
            id: { type: 'string' },
            title: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_a, v) => [{ type: 'text', text: v.removed ? `已移除 [${v.id}] ${v.title}` : '未找到匹配的文献' }],
      },
      async execute(args) {
        const library = await lib()
        const r = library.removePaper(args.paper)
        if (!r) return { removed: false }
        await library.save()
        return { removed: true, ...r }
      },
    }),
  )
}
