// 无依赖测试：node test/run.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { buildCnkiSearchUrl } from '../lib/url.js'
import { decodeExportBuffer, parseCnkiExport } from '../lib/parse-export.js'

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

// ---------- URL 构造 ----------
test('关键词模式生成 defaultresult URL', () => {
  const r = buildCnkiSearchUrl({ query: '情势变更 合同解除' })
  assert.equal(r.mode, 'keyword')
  assert.match(r.url, /^https:\/\/kns\.cnki\.net\/kns8s\/defaultresult\/index\?dbcode=CFLS&kw=/)
  assert.ok(r.url.includes(encodeURIComponent('情势变更 合同解除')))
  assert.ok(r.url.includes('korder=SU'))
  assert.ok(r.guidance.length > 10)
})

test('字段与库代码参数生效', () => {
  const r = buildCnkiSearchUrl({ query: '王泽鉴', field: 'AU', dbcode: 'CJFD' })
  assert.ok(r.url.includes('korder=AU'))
  assert.ok(r.url.includes('dbcode=CJFD'))
})

test('专业检索模式返回 AdvSearch 链接与检索式', () => {
  const expr = "SU='合同无效' AND SU='强制性规定'"
  const r = buildCnkiSearchUrl({ professional: expr })
  assert.equal(r.mode, 'professional')
  assert.ok(r.url.startsWith('https://kns.cnki.net/kns8s/AdvSearch?dbcode=CFLS'))
  assert.equal(r.expression, expr)
})

test('参数缺失/冲突时抛错', () => {
  assert.throws(() => buildCnkiSearchUrl({}))
  assert.throws(() => buildCnkiSearchUrl({ query: 'a', professional: 'b' }))
  assert.throws(() => buildCnkiSearchUrl({ query: 'a', field: 'XX' }))
  assert.throws(() => buildCnkiSearchUrl({ query: 'a', dbcode: 'NOPE' }))
})

// ---------- 编码解码 ----------
test('UTF-8 BOM 与无 BOM 均正确解码', () => {
  const noBom = Buffer.from('题名：测试', 'utf8')
  assert.equal(decodeExportBuffer(noBom), '题名：测试')
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), noBom])
  assert.equal(decodeExportBuffer(bom), '题名：测试')
})

test('GBK/GB18030 字节自动兜底解码', () => {
  // 0xD6D0 0xCEC4 = "中文" 的 GBK 编码，非合法 UTF-8
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(decodeExportBuffer(gbk), '中文')
})

// ---------- 知网自定义格式 ----------
test('解析 cnki-custom（含多行摘要与多作者）', () => {
  const text = readFileSync(join(dir, 'fixtures', 'cnki-custom.txt'), 'utf8')
  const r = parseCnkiExport(text)
  assert.equal(r.format, 'cnki-custom')
  assert.equal(r.count, 2)
  const [a, b] = r.papers
  assert.equal(a.title, '论效力性强制性规定的识别标准')
  assert.deepEqual(a.authors, ['王利明', '朱 晗'])
  assert.equal(a.source, '中国法学')
  assert.equal(a.pub_date, '2023-03-15')
  assert.deepEqual(a.keywords, ['强制性规定', '合同无效', '效力性强制性规定', '识别标准'])
  assert.ok(a.abstract.includes('类型化的裁判思路'))
  assert.deepEqual(b.authors, ['韩世远'])
  assert.ok(b.abstract.includes('以及情势变更情形下')) // 跨行摘要被拼接
})

// ---------- EndNote 格式 ----------
test('解析 endnote（%A 逐行追加作者、%X 跨行摘要）', () => {
  const text = readFileSync(join(dir, 'fixtures', 'endnote.txt'), 'utf8')
  const r = parseCnkiExport(text)
  assert.equal(r.format, 'endnote')
  assert.equal(r.count, 2)
  const [a, b] = r.papers
  assert.deepEqual(a.authors, ['陆青', '张XX'])
  assert.equal(a.source, '法学家')
  assert.ok(a.abstract.includes('合理期限规则'))
  assert.ok(a.url.includes('kns.cnki.net'))
  assert.equal(a.pages, '89-102')
  assert.equal(b.title, '违约方解除困境的教义学出路')
})

// ---------- RefWorks 格式 ----------
test('解析 refworks', () => {
  const text = readFileSync(join(dir, 'fixtures', 'refworks.txt'), 'utf8')
  const r = parseCnkiExport(text)
  assert.equal(r.format, 'refworks')
  assert.equal(r.count, 1)
  const p = r.papers[0]
  assert.equal(p.title, '担保制度司法解释的规范分析')
  assert.deepEqual(p.authors, ['高圣平'])
  assert.equal(p.source, '清华法学')
  assert.equal(p.pub_date, '2022')
})

// ---------- TSV 与异常 ----------
test('解析制表符分隔 txt', () => {
  const tsv = '题名\t作者\t来源\t摘要\n论缔约过失\t甲；乙\t法商研究\t摘要内容\n'
  const r = parseCnkiExport(tsv)
  assert.equal(r.format, 'tsv')
  assert.equal(r.count, 1)
  assert.deepEqual(r.papers[0].authors, ['甲', '乙'])
})

test('未知格式抛出带指引的错误', () => {
  assert.throws(() => parseCnkiExport('随便一段话，没有任何可识别的格式。'), /无法识别的导出格式/)
})

// ---------- 真实导出格式（2026-10 实测知网导出页"自定义"格式，双语标签） ----------
test('解析真实知网导出文件（Title-题名 双语标签，含摘要）', () => {
  const text = readFileSync(join(dir, 'fixtures', 'real-custom.txt'), 'utf8')
  const r = parseCnkiExport(text)
  assert.equal(r.format, 'cnki-custom')
  assert.equal(r.count, 3)
  const [a, b, c] = r.papers
  assert.equal(a.title, '论利益平衡视角下非恶意违约方的合同解除自由')
  assert.deepEqual(a.authors, ['李少伟', '吕立波'])
  assert.equal(a.source, '邵阳学院学报(社会科学版)')
  assert.equal(a.type, '期刊')
  assert.equal(a.pub_date, '2026-08-28')
  assert.deepEqual(a.keywords, ['合同解除', '不适宜强制履行的合同', '金钱债务', '非金钱债务'])
  assert.ok(a.abstract.includes('第五百八十条'))
  assert.deepEqual(b.authors, ['陈维一'])
  assert.equal(b.type, '期刊')
  assert.ok(b.abstract.includes('司法解除权'))
  assert.equal(c.type, '硕士')
  assert.equal(c.pub_date, '2026-06-01')
  assert.ok(c.abstract.length > 200, '硕士论文长摘要完整保留')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
