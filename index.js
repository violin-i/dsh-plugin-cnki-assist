import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildCnkiSearchUrl } from './lib/url.js'
import { decodeExportBuffer, parseCnkiExport } from './lib/parse-export.js'

export const name = 'cnki-assist'
export const inject = ['tools']

// 题录记录的完整字段集（与 lib/parse-export.js 的 finalize 输出保持一致）
const paperSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    source: { type: 'string' },
    pub_date: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    abstract: { type: 'string' },
    type: { type: 'string' },
    url: { type: 'string' },
    doi: { type: 'string' },
    pages: { type: 'string' },
    volume: { type: 'string' },
    issue: { type: 'string' },
    organization: { type: 'string' },
  },
  additionalProperties: false,
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'cnki_search_url',
      description:
        '生成中国知网(CNKI)检索链接：把简单关键词或专业检索式转换为可直接在浏览器打开的知网 URL。' +
        '当用户要"查文献/找论文/检索知网"时先调用本工具拿到链接，再指导用户打开。' +
        '本工具不访问知网、不抓取内容，只生成链接与检索策略提示。',
      parameters: {
        query: {
          type: 'string',
          description: '简单检索关键词，如"情势变更原则 合同解除"。与 professional 二选一。',
        },
        professional: {
          type: 'string',
          description:
            "知网专业检索式，如 SU='合同无效' AND SU='强制性规定'。与 query 二选一。提供时返回专业检索页链接，由用户粘贴检索式执行。",
        },
        field: {
          type: 'string',
          enum: ['SU', 'TI', 'AB', 'KY', 'FT', 'AU'],
          description: '检索字段（仅 query 模式）：SU 主题(默认)、TI 篇名、AB 摘要、KY 关键词、FT 全文、AU 作者。',
        },
        dbcode: {
          type: 'string',
          enum: ['CFLS', 'CJFD', 'CDFDL', 'CMFD', 'CIPD'],
          description: '库范围：CFLS 跨库总库(默认)、CJFD 学术期刊、CDFDL 博士论文、CMFD 硕士论文、CIPD 会议。',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            url: { type: 'string', required: true },
            mode: { type: 'string', enum: ['keyword', 'professional'], required: true },
            expression: { type: 'string' },
            guidance: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: `${value.url}\n${value.guidance}${value.expression ? `\n检索式：${value.expression}` : ''}` },
        ],
      },
      async execute(args) {
        return buildCnkiSearchUrl(args)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'cnki_parse_export',
      description:
        '解析知网检索结果页"导出文献"生成的题录文件（txt），返回结构化的论文列表（题名/作者/期刊/年份/关键词/摘要/链接）。' +
        '支持格式：知网"自定义"、EndNote、RefWorks、制表符分隔。文件编码支持 UTF-8 与 GB18030。' +
        '用户从知网手动导出题录文件后，调用本工具解析，随后可基于返回列表做相关度排序、筛选与逐篇一句话摘要。',
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: '知网导出的题录 txt 文件的绝对路径。',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            format: { type: 'string', required: true },
            count: { type: 'number', required: true },
            papers: { type: 'array', items: paperSchema, required: true },
            warnings: { type: 'array', items: { type: 'string' }, required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `已解析 ${value.count} 条题录（格式：${value.format}）：\n` +
              value.papers.map((p, i) => `${i + 1}. ${p.title}${p.source ? `（《${p.source}》${p.pub_date ?? ''}）` : ''}`).join('\n') +
              (value.warnings.length ? `\n警告：${value.warnings.join('；')}` : ''),
          },
        ],
      },
      async execute(args, exec) {
        const buf = await readFile(args.file_path, { signal: exec.signal })
        const text = decodeExportBuffer(buf)
        return parseCnkiExport(text)
      },
    }),
  )
}
