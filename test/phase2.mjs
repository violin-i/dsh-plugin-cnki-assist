// 阶段 2 测试：node test/phase2.mjs（守护核心 + guard/skill 入口加载）
import assert from 'node:assert/strict'
import { createCnkiGuard, CNKI_DOWNLOAD_RE } from '../lib/guard-core.js'

let passed = 0
let failed = 0
const tests = []
function test(name, fn) {
  tests.push([name, fn])
}

// ---------- 守护核心 ----------
test('非知网调用直接放行且不消耗配额', () => {
  let t = 1000000
  const decide = createCnkiGuard({ now: () => t })
  assert.deepEqual(decide('browser_navigate', { url: 'https://example.com/a' }), { action: 'allow' })
  assert.deepEqual(decide('browser_click', { selector: '.x' }), { action: 'allow' })
  assert.deepEqual(decide('read_file', { path: 'C:/a.txt' }), { action: 'allow' })
})

test('下载端点被拦截（caj/pdf/aspx/download）', () => {
  const decide = createCnkiGuard()
  for (const url of [
    'https://kns.cnki.net/kcms/download.aspx?filename=ABC123.caj&dbcode=CJFD',
    'https://cnki.net/kcms2/article/download?fn=X.pdf',
    'https://kns.cnki.net/kns8s/download?dbcode=CJFD&filename=ZD202301.caj',
  ]) {
    const d = decide('browser_navigate', { url })
    assert.equal(d.action, 'deny', url)
    assert.ok(d.reason.includes('手动下载'))
  }
})

test('详情页与检索结果页放行', () => {
  let t = 0
  const decide = createCnkiGuard({ now: () => t })
  assert.equal(decide('browser_navigate', { url: 'https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD&filename=FXJ202101001' }).action, 'allow')
  t = 5000
  assert.equal(
    decide('browser_navigate', { url: 'https://kns.cnki.net/kns8s/defaultresult/index?dbcode=CFLS&kw=%E5%90%88%E5%90%8C' }).action,
    'allow',
  )
  // CNKI_DOWNLOAD_RE 不误伤 detail.aspx
  assert.ok(!CNKI_DOWNLOAD_RE.test('https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD&filename=FXJ202101001'))
})

test('最小间隔限速', () => {
  let t = 0
  const decide = createCnkiGuard({ now: () => t, minIntervalMs: 4000 })
  assert.equal(decide('browser_navigate', { url: 'https://kns.cnki.net/kns8s/defaultresult/index?kw=a' }).action, 'allow')
  t = 2000
  const d = decide('browser_navigate', { url: 'https://kns.cnki.net/kns8s/defaultresult/index?kw=b' })
  assert.equal(d.action, 'deny')
  assert.ok(d.reason.includes('频繁'))
  t = 4100
  assert.equal(decide('browser_navigate', { url: 'https://kns.cnki.net/kns8s/defaultresult/index?kw=c' }).action, 'allow')
})

test('窗口配额用尽后拒绝并引导降级', () => {
  let t = 0
  const decide = createCnkiGuard({ now: () => t, maxCalls: 2, windowMs: 10000, minIntervalMs: 0 })
  assert.equal(decide('n', { url: 'https://cnki.net/kns8s/x?kw=1' }).action, 'allow')
  t = 100
  assert.equal(decide('n', { url: 'https://cnki.net/kns8s/x?kw=2' }).action, 'allow')
  t = 200
  const d = decide('n', { url: 'https://cnki.net/kns8s/x?kw=3' })
  assert.equal(d.action, 'deny')
  assert.ok(d.reason.includes('cnki_parse_export'))
  // 窗口滑过后恢复
  t = 10200
  assert.equal(decide('n', { url: 'https://cnki.net/kns8s/x?kw=4' }).action, 'allow')
})

test('参数可为字符串或对象', () => {
  const decide = createCnkiGuard()
  assert.equal(decide('browser_type', { text: '打开 https://kns.cnki.net/kcms/download.aspx?f=x.pdf' }).action, 'deny')
  assert.equal(decide('browser_type', '请访问 https://cnki.net/kcms/download.aspx?f=x.pdf').action, 'deny')
})

// ---------- 入口加载（stub ctx，无需 dsh 依赖） ----------
test('guard.js 注册 pre-execute 监听并返回 deny 决策', async () => {
  const handlers = {}
  const ctx = {
    on: (event, handler) => {
      handlers[event] = handler
    },
    logger: { info() {} },
  }
  const mod = await import('../guard.js')
  assert.equal(mod.name, 'cnki-assist-guard')
  assert.deepEqual(mod.inject, ['tools'])
  mod.apply(ctx)
  assert.ok(handlers['tools/pre-execute'], '已挂载 tools/pre-execute')
  const deny = await handlers['tools/pre-execute'](
    { name: 'browser_navigate', arguments: { url: 'https://kns.cnki.net/kcms/download.aspx?filename=A.caj' } },
    () => ({ kind: 'allow' }),
  )
  assert.equal(deny.kind, 'deny')
  assert.ok(deny.reason)
  const pass = await handlers['tools/pre-execute'](
    { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
    () => ({ kind: 'ok-next' }),
  )
  assert.deepEqual(pass, { kind: 'ok-next' }, '非知网调用透传 next()')
})

test('skill.js 注册 cnki-search 运行时技能', async () => {
  const registered = []
  const ctx = { skills: { register: (s) => registered.push(s) } }
  const mod = await import('../skill.js')
  assert.equal(mod.name, 'cnki-assist-skill')
  assert.deepEqual(mod.inject, ['skills'])
  mod.apply(ctx)
  assert.equal(registered.length, 2, 'cnki-search + law-workbench 两个技能')
  assert.equal(registered[0].name, 'cnki-search')
  assert.match(registered[0].name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case 名称')
  assert.ok(registered[0].description.length > 10)
  assert.ok(registered[0].content.includes('永不点击下载'))
  assert.ok(registered[0].content.includes('cnki_parse_export'))
  assert.ok(registered[1].content.includes('law_lib_citation'), 'workbench 技能含引注工作流')
})

// ---------- 执行（async 失败必须算 FAIL） ----------
for (const [name, fn] of tests) {
  try {
    await fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL ${name}\n  ${err.message}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
