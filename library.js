// 法学文献库工作台：本地文献入库、检索、阅读、引注（本地 BM25，零网络、零密钥）
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Library, expandQuery } from './lib/collection.js'
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
      description: '列出法学文献库中的全部文献（id、标题、页数、块数、笔记数、阅读进度）。做总结/对比/综述前先调用本工具掌握库内有什么。',
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
                  notes: { type: 'number' },
                  progress: {
                    type: 'object',
                    properties: { offset: { type: 'number', required: true }, pct: { type: 'number', required: true } },
                    additionalProperties: false,
                  },
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
              ? `库内 ${v.count} 篇：\n` +
                v.papers
                  .map(
                    (p) =>
                      `· [${p.id}] ${p.title}（${p.chars}字/${p.chunks}块${p.notes ? `/${p.notes}笔记` : ''}${p.progress ? `/读到${p.progress.pct}%` : ''}）`,
                  )
                  .join('\n')
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
        '在法学文献库内做 BM25 全文检索，返回最相关的文块（含出处与片段，命中词以【】标出）。' +
        '默认开启法律概念扩展：检索词命中内置概念表（如"情势变更""效力性强制性规定"）时自动补齐同义表述，提升召回。' +
        '用于：定位某个论点的原文位置、跨文献比较同一问题、综述时按主题取材。检索词用中文自然词组效果最好（如"效力性强制性规定的识别标准"）。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词' },
        top_k: { type: 'number', description: '返回块数，默认 8' },
        paper_id: { type: 'string', description: '可选：只在指定文献内检索' },
        expand: { type: 'boolean', description: '概念扩展，默认开启；只要字面命中时传 false' },
        highlight: { type: 'boolean', description: '片段中用【】标出命中词，默认开启' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            expanded: { type: 'array', items: { type: 'string' } },
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
            text:
              (v.expanded?.length ? `已扩展概念词：${v.expanded.join('、')}\n` : '') +
              (v.results.length
                ? v.results.map((r) => `· [${r.paper_id}]《${r.title}》#${r.chunk_index} (score ${r.score})\n  ${r.snippet}`).join('\n\n')
                : '无命中块。可尝试更换检索词或检查文献是否已入库。'),
          },
        ],
      },
      async execute(args) {
        const library = await lib()
        const results = library.search(args.query, {
          topK: args.top_k ?? 8,
          paperId: args.paper_id,
          expand: args.expand !== false,
          highlight: args.highlight !== false,
        })
        return { expanded: args.expand === false ? [] : expandQuery(args.query), results }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_read',
      description:
        '读取库内一篇文献的全文或大纲。part=outline 返回章节标题列表（先看结构）；part=text 按 offset/limit 窗口读正文（每次默认 6000 字，滚动读取）。' +
        'save_progress=true 时把本次读取位置存为阅读进度（工作台面板会显示"继续阅读"）。' +
        '做单篇精读总结时：先 outline 再按窗口通读；只需定位论点时优先用 law_lib_search。',
      parameters: {
        paper_id: { type: 'string', required: true, description: '文献 id 或标题' },
        part: { type: 'string', enum: ['text', 'outline'], description: '默认 text' },
        offset: { type: 'number', description: '正文起始字符位置，默认 0' },
        limit: { type: 'number', description: '本次读取字符数上限，默认 6000' },
        save_progress: { type: 'boolean', description: '保存本次读取位置为阅读进度，默认 false' },
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
            progress: {
              type: 'object',
              properties: { offset: { type: 'number', required: true }, updated_at: { type: 'string', required: true } },
              additionalProperties: false,
            },
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
        let progress = r.progress
        if (args.save_progress) {
          progress = library.setProgress(r.id, r.offset)
          await library.save()
        }
        return { ...r, kind: 'text', progress: progress ?? undefined }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_note',
      description:
        '文献笔记：摘录原文片段并写批注（综述素材）。action=add 需 paper 与 comment（quote 建议贴原文或检索片段）；' +
        'action=list 列出笔记（paper 缺省列全库）；action=remove 需 paper 与 note_id。笔记随文献库持久化，写综述时按文献取用。',
      parameters: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: '默认 add' },
        paper: { type: 'string', description: '文献 id / 标题（add/remove 必填，list 可选）' },
        quote: { type: 'string', description: '摘录的原文片段（add，建议 <=200 字）' },
        comment: { type: 'string', description: '批注内容（add 必填）' },
        chunk_index: { type: 'number', description: '关联的块号（add，可选，便于回跳原文）' },
        note_id: { type: 'string', description: '笔记 id（remove 必填）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', required: true },
            added: {
              type: 'object',
              properties: {
                note_id: { type: 'string', required: true },
                paper_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
            removed: { type: 'boolean' },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  note_id: { type: 'string', required: true },
                  paper_id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  quote: { type: 'string' },
                  comment: { type: 'string', required: true },
                  chunk_index: { type: 'number' },
                  created_at: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        render: (_a, v) => {
          if (v.action === 'add' && v.added)
            return [{ type: 'text', text: `笔记已添加 [${v.added.note_id}] → [${v.added.paper_id}]《${v.added.title}》` }]
          if (v.action === 'remove')
            return [{ type: 'text', text: v.removed ? '笔记已删除' : '未找到该笔记' }]
          const notes = v.notes ?? []
          return [
            {
              type: 'text',
              text: notes.length
                ? `共 ${notes.length} 条笔记：\n` +
                  notes
                    .map(
                      (n) =>
                        `· [${n.note_id}]《${n.title}》${n.chunk_index != null ? `#${n.chunk_index}` : ''}\n  摘录：${n.quote || '（无）'}\n  批注：${n.comment}`,
                    )
                    .join('\n')
                : '暂无笔记。读到关键段落时可用 law_lib_note(action=add) 摘录并写批注。',
            },
          ]
        },
      },
      async execute(args) {
        const library = await lib()
        const action = args.action ?? 'add'
        if (action === 'add') {
          if (!args.paper) throw new Error('添加笔记需要 paper（文献 id 或标题）')
          if (!args.comment) throw new Error('添加笔记需要 comment（批注内容）')
          const r = library.addNote(args.paper, { quote: args.quote, comment: args.comment, chunkIndex: args.chunk_index })
          if (!r) throw notFound(args.paper)
          await library.save()
          return { action, added: { note_id: r.note.id, paper_id: r.paper.id, title: r.paper.title } }
        }
        if (action === 'remove') {
          if (!args.paper || !args.note_id) throw new Error('删除笔记需要 paper 与 note_id')
          const r = library.removeNote(args.paper, args.note_id)
          if (!r) return { action, removed: false }
          await library.save()
          return { action, removed: true }
        }
        return { action, notes: library.listNotes(args.paper) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'law_lib_related',
      description:
        '推荐与指定文献主题相近的其他库内文献（按标题+开篇内容的 BM25 交叉打分），并给出双方共现的概念词。' +
        '用于：综述时找同主题文献、对比研究前摸清库内的观点亲缘关系。',
      parameters: {
        paper: { type: 'string', required: true, description: '文献 id 或标题' },
        top_k: { type: 'number', description: '返回篇数，默认 5' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            base: {
              type: 'object',
              properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true } },
              additionalProperties: false,
              required: true,
            },
            related: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  paper_id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  score: { type: 'number', required: true },
                  best_chunk: { type: 'number' },
                  shared: { type: 'array', items: { type: 'string' } },
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
            text: v.related.length
              ? `与《${v.base.title}》相关的文献：\n` +
                v.related.map((r) => `· [${r.paper_id}]《${r.title}》(score ${r.score}${r.shared.length ? `；共现：${r.shared.join('、')}` : ''})`).join('\n')
              : `库内暂无与《${v.base.title}》主题相近的其他文献。`,
          },
        ],
      },
      async execute(args) {
        const library = await lib()
        const r = library.related(args.paper, { topK: args.top_k ?? 5 })
        if (!r) throw notFound(args.paper)
        return r
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
