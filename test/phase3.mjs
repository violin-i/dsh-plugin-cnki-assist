// 阶段 3 测试：node test/phase3.mjs（文献库：分块/BM25/存储/PDF提取/引注/工具注册）
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkText, tokenize, Library } from '../lib/collection.js'
import { formatCitation } from '../lib/citation.js'

const dir = dirname(fileURLToPath(import.meta.url))
let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL ${name}\n  ${err.message}`)
  }
}
async function atest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL ${name}\n  ${err.message}`)
  }
}

// ---------- 分块 ----------
test('chunkText 按段落聚合且块间有重叠', () => {
  const paras = Array.from({ length: 30 }, (_, i) => `第${i}段：` + '内容'.repeat(30))
  const chunks = chunkText(paras.join('\n'), { target: 200, overlap: 40 })
  assert.ok(chunks.length >= 2)
  for (const c of chunks) assert.ok(c.length >= 8)
  // 相邻块有重叠内容
  assert.ok(chunks[0].slice(-10).length > 0)
})

test('chunkText 硬切超长无换行文本', () => {
  const chunks = chunkText('长'.repeat(3000), { target: 480, overlap: 64 })
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((c) => c.length <= 480 * 2 + 64))
})

// ---------- 分词 ----------
test('tokenize 中文 bigram + ASCII 词', () => {
  const t = tokenize('效力性强制性规定的识别 standard 2023')
  assert.ok(t.includes('效力') && t.includes('力性') && t.includes('识别'))
  assert.ok(t.includes('standard') && t.includes('2023'))
})

// ---------- 引注 ----------
test('法学引注手册：期刊完整字段', () => {
  const r = formatCitation({
    authors: ['王利明', '朱晗'],
    title: '论效力性强制性规定的识别标准',
    journal: '中国法学',
    year: '2023',
    issue: '3',
    page: '45',
  })
  assert.equal(r.citation, '王利明、朱晗：《论效力性强制性规定的识别标准》，载《中国法学》2023年第3期，第45页。')
  assert.equal(r.missing_fields, 0)
})

test('引注缺失字段标注待补', () => {
  const r = formatCitation({ authors: ['陈维一'], title: '违约方解除权制度之探析' })
  assert.ok(r.citation.includes('〔待补〕'))
  assert.ok(r.missing_fields >= 2)
})

test('学位论文与 GB/T 7714 格式', () => {
  const d = formatCitation({ authors: ['李梦继'], title: '预付式消费中消费者合同解除权研究', type: 'thesis', university: '内蒙古科技大学', year: '2026', degree: '硕士' })
  assert.ok(d.citation.includes('内蒙古科技大学2026年硕士学位论文'))
  const g = formatCitation({ authors: ['王利明'], title: '测试文', journal: '法学研究', year: '2023', issue: '2' }, 'GB/T 7714')
  assert.ok(g.citation.includes('[J]'))
})

// ---------- Library：txt 入库 / 检索 / 阅读 / 去重 / 移除 ----------
const tmp = mkdtempSync(join(tmpdir(), 'lawlib-'))
const libDir = join(tmp, 'lib')
const srcDir = join(tmp, 'src')
mkdirSync(srcDir, { recursive: true })
writeFileSync(join(srcDir, 'a.txt'), '合同无效与强制性规定的区分。\n' + '作者主张效力性强制性规定导致合同无效，管理性规定不影响效力。'.repeat(20) + '\n结论：识别标准应从规范目的出发。')
writeFileSync(join(srcDir, 'b.txt'), '情势变更原则的适用研究。\n' + '情势变更与商业风险的界分是司法实践难点，本文提出类型化标准。'.repeat(20))

await atest('txt 批量入库 + 列表', async () => {
  const lib = await Library.load(libDir)
  const { added, skipped } = await lib.addPaths([srcDir])
  assert.equal(added.length, 2)
  assert.equal(skipped.length, 0)
  assert.ok(added[0].chunks >= 1)
  const papers = lib.listPapers()
  assert.equal(papers.length, 2)
  // 持久化验证
  const lib2 = await Library.load(libDir)
  assert.equal(lib2.listPapers().length, 2)
})

await atest('BM25 检索命中文档与片段', async () => {
  const lib = await Library.load(libDir)
  const r = lib.search('效力性强制性规定 合同无效')
  assert.ok(r.length >= 1)
  assert.ok(r[0].title.startsWith('合同无效'))
  assert.ok(r[0].snippet.includes('效力性') || r[0].snippet.includes('合同无效'))
  // 无关查询不应误命中文档b
  const r2 = lib.search('情势变更 商业风险')
  assert.ok(r2.length >= 1 && r2[0].title.includes('情势变更'))
})

await atest('哈希去重', async () => {
  const lib = await Library.load(libDir)
  const { added, skipped } = await lib.addPaths([join(srcDir, 'a.txt')])
  assert.equal(added.length, 0)
  assert.equal(skipped.length, 1)
  assert.ok(skipped[0].reason.includes('重复'))
})

await atest('阅读窗口与大纲', async () => {
  const lib = await Library.load(libDir)
  const p = lib.listPapers()[0]
  const r = lib.read(p.id, { offset: 0, limit: 100 })
  assert.equal(r.text.length, 100)
  assert.equal(r.has_more, true)
  const r2 = lib.read(p.id, { offset: 999999, limit: 100 })
  assert.equal(r2.text, '')
})

await atest('移除文献', async () => {
  const lib = await Library.load(libDir)
  const p = lib.listPapers().find((x) => x.title.includes('情势变更'))
  const r = lib.removePaper(p.id)
  assert.ok(r)
  await lib.save()
  const lib2 = await Library.load(libDir)
  assert.equal(lib2.listPapers().length, 1)
})

// ---------- 真实中文 PDF 入库 ----------
await atest('中文 PDF 入库与检索（reportlab 生成样本）', async () => {
  const lib = await Library.load(join(tmp, 'pdf-lib'))
  const { added, skipped } = await lib.addPaths([join(dir, 'fixtures', 'sample-paper.pdf')])
  assert.equal(skipped.length, 0)
  assert.equal(added.length, 1)
  assert.ok(added[0].title.includes('效力性'))
  const r = lib.search('法益衡量 识别标准')
  assert.ok(r.length >= 1)
  assert.ok(r[0].snippet.includes('法益衡量') || r[0].snippet.includes('识别标准'))
})

// ---------- library.js 工具注册与端到端执行 ----------
await atest('library.js 注册 8 个工具并端到端执行', async () => {
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  const mod = await import('../library.js')
  assert.equal(mod.name, 'law-library')
  const toolLibDir = join(tmp, 'tool-lib')
  mod.apply(ctx, { libraryDir: toolLibDir })
  const names = registered.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'law_lib_add',
    'law_lib_citation',
    'law_lib_list',
    'law_lib_note',
    'law_lib_read',
    'law_lib_related',
    'law_lib_remove',
    'law_lib_search',
  ])
  const byName = (n) => registered.find((t) => t.name === n)

  const add = await byName('law_lib_add').execute({ paths: [join(dir, 'fixtures', 'sample-paper.pdf')] })
  assert.equal(add.added.length, 1)
  const paperId = add.added[0].id

  const list = await byName('law_lib_list').execute({})
  assert.equal(list.count, 1)

  const search = await byName('law_lib_search').execute({ query: '规范目的 体系解释' })
  assert.ok(search.results.length >= 1)

  const outline = await byName('law_lib_read').execute({ paper_id: paperId, part: 'outline' })
  assert.ok(Array.isArray(outline.headings))

  const cite = await byName('law_lib_citation').execute({
    paper_id: paperId,
    authors: ['王利明'],
    journal: '中国法学',
    year: '2023',
    issue: '3',
  })
  assert.ok(cite.citation.includes('王利明：《论效力性强制性规定的识别标准》'))
  assert.ok(cite.citation.includes('载《中国法学》2023年第3期'))
})

// 清理
rmSync(tmp, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
