// 阶段 4 测试：node test/phase4.mjs（概念扩展/高亮/相关推荐/笔记/进度/v1 兼容）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Library, expandQuery, highlightTerms, tokenize } from '../lib/collection.js'

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

// ---------- 概念扩展 ----------
test('expandQuery 命中主词补同义词', () => {
  const extras = expandQuery('情势变更的构成要件')
  assert.ok(extras.includes('不可抗力'))
  assert.ok(extras.includes('再交涉'))
  assert.ok(!extras.includes('情势变更'))
})

test('expandQuery 未命中返回空', () => {
  assert.deepEqual(expandQuery(' adorable cat '), [])
  assert.deepEqual(expandQuery(''), [])
})

test('expandQuery 不重复添加 query 已有词', () => {
  const extras = expandQuery('情势变更与不可抗力')
  assert.ok(!extras.includes('不可抗力'))
})

// ---------- 高亮 ----------
test('highlightTerms 长词优先且不嵌套', () => {
  const out = highlightTerms('效力性强制性规定的识别', ['效力性强制性规定', '强制性规定'])
  assert.equal(out, '【效力性强制性规定】的识别')
  assert.ok(!out.includes('【效力性【'))
})

test('highlightTerms 转义正则元字符', () => {
  const out = highlightTerms('a.b 与 c', ['a.b'])
  assert.equal(out, '【a.b】 与 c')
})

// ---------- 片段选择 ----------
test('search 片段覆盖命中词且带高亮', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4-'))
  try {
    const lib = new Library(tmp)
    const text = Array.from({ length: 40 }, (_, i) => `第${i}段，这里讨论违约金调整规则。第${i}段尾。`).join('\n')
    text += '\n损害赔偿范围受可预见性规则约束，违约金过分高于实际损失时可请求酌减。'
    await lib.addPaths([writeTmp(tmp, 'a.txt', text)])
    const r = lib.search('违约金 酌减 可预见性')
    assert.ok(r.length >= 1)
    const hit = r.find((x) => x.snippet.includes('酌减'))
    assert.ok(hit, '应命中含酌减的块')
    assert.ok(hit.snippet.includes('【违约金】') || hit.snippet.includes('【酌减】'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

function writeTmp(tmp, name, content) {
  const p = join(tmp, name)
  writeFileSync(p, content, 'utf8')
  return p
}

// ---------- 相关文献推荐 ----------
test('related 返回主题相近文献与共现词', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4b-'))
  try {
    const lib = new Library(tmp)
    await lib.addPaths([
      writeTmp(tmp, 'a.txt', '论效力性强制性规定的识别标准。\n' + '强制性规定与合同无效的判断。规范性质的识别。\n'.repeat(30)),
      writeTmp(tmp, 'b.txt', '合同无效后的返还与赔偿。\n' + '效力性强制性规定影响合同效力，无效后果由过错分担。\n'.repeat(30)),
      writeTmp(tmp, 'c.txt', '劳动合同解除的经济补偿。\n' + '劳动关系、经济补偿金与违法解除赔偿金。\n'.repeat(30)),
    ])
    const r = lib.related('a.txt', { topK: 2 })
    assert.equal(r.base.title.length > 0, true)
    assert.ok(r.related.length >= 1)
    assert.equal(r.related[0].title.includes('合同无效'), true, '最相关的应是合同无效一篇')
    assert.ok(Array.isArray(r.related[0].shared))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('related 不把自己算进来', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4c-'))
  try {
    const lib = new Library(tmp)
    await lib.addPaths([writeTmp(tmp, 'only.txt', '唯一的文献。\n'.repeat(20))])
    const r = lib.related('only.txt')
    assert.deepEqual(r.related, [])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------- 笔记 ----------
test('addNote/listNotes/removeNote 往返', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4d-'))
  try {
    const lib = new Library(tmp)
    await lib.addPaths([writeTmp(tmp, 'a.txt', '标题行\n' + '正文内容。'.repeat(50))])
    const added = lib.addNote('a.txt', { quote: '正文内容。', comment: '关键论点', chunkIndex: 0 })
    assert.ok(added.note.id)
    assert.equal(lib.listNotes().length, 1)
    assert.equal(lib.listNotes()[0].comment, '关键论点')
    const rm = lib.removeNote('a.txt', added.note.id)
    assert.ok(rm)
    assert.equal(lib.listNotes().length, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('addNote 文献不存在返回 null', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4e-'))
  try {
    const lib = new Library(tmp)
    assert.equal(lib.addNote('p999', { comment: 'x' }), null)
    assert.equal(lib.removeNote('p999', 'n1'), null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------- 阅读进度 ----------
test('setProgress 与 read 携带进度', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4f-'))
  try {
    const lib = new Library(tmp)
    await lib.addPaths([writeTmp(tmp, 'a.txt', 'x'.repeat(1000))])
    const prog = lib.setProgress('a.txt', 600)
    assert.equal(prog.offset, 600)
    const r = lib.read('a.txt', { offset: 0, limit: 100 })
    assert.equal(r.progress.offset, 600)
    // 越界钳制
    lib.setProgress('a.txt', 99999)
    assert.ok(lib.getPaper('a.txt').progress.offset <= 1000)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------- v1 兼容 ----------
test('v1 数据加载自动补 notes/progress 并升 v2', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4g-'))
  try {
    mkdirSync(tmp, { recursive: true })
    writeFileSync(
      join(tmp, 'library.json'),
      JSON.stringify({
        version: 1,
        nextId: 2,
        papers: [
          {
            id: 'p1',
            title: '旧版文献',
            path: 'D:/x.pdf',
            hash: 'h',
            pages: 3,
            addedAt: '2026-01-01T00:00:00.000Z',
            meta: {},
            text: '旧正文',
            chunks: ['旧正文'],
          },
        ],
      }),
      'utf8',
    )
    const lib = await Library.load(tmp)
    assert.equal(lib.data.papers[0].notes.length, 0)
    assert.equal(lib.data.papers[0].progress, null)
    await lib.save()
    const raw = JSON.parse(readFileSync(join(tmp, 'library.json'), 'utf8'))
    assert.equal(raw.version, 2)
    assert.ok(raw.papers[0].notes)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------- 概念扩展实际提升召回 ----------
test('概念扩展提升同义表述召回', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lws4h-'))
  try {
    const lib = new Library(tmp)
    // 文中只出现"不可抗力"，不出现"情势变更"
    await lib.addPaths([writeTmp(tmp, 'a.txt', '论不可抗力的免责效果。\n' + '不能预见、不能避免且不能克服的客观情况。免责事由。\n'.repeat(30))])
    const plain = lib.search('情势变更', { expand: false })
    const expanded = lib.search('情势变更', { expand: true })
    assert.equal(plain.length, 0)
    assert.ok(expanded.length >= 1, '扩展后应命中不可抗力文块')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------- tokenizer 回归 ----------
test('tokenize 基本行为不变', () => {
  const t = tokenize('合同无效 standard')
  assert.ok(t.includes('合同') && t.includes('standard'))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
