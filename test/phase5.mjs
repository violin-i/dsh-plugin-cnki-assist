// 阶段 5 测试：node test/phase5.mjs（守护层管线级集成：模拟 dsh 工具执行管线 + 逃逸向量）
import assert from 'node:assert/strict'
import { createCnkiGuard } from '../lib/guard-core.js'

let passed = 0
let failed = 0
const tests = []
function test(name, fn) {
  tests.push([name, fn])
}

/**
 * 构造一个最小 dsh 工具管线：guard 的 pre-execute 钩子 + mock 执行器。
 * 返回 { call(name, args), executed, denied }。
 * 被守护拒绝的调用绝不能到达执行器。
 */
function buildPipeline(guardOptions = {}) {
  const handlers = {}
  const ctx = {
    on: (event, handler) => {
      handlers[event] = handler
    },
    logger: { info() {} },
  }
  const decide = createCnkiGuard(guardOptions)
  handlers['tools/pre-execute'] = (exec, next) => {
    const decision = decide(exec.name, exec.arguments)
    if (decision.action === 'deny') return Promise.resolve({ kind: 'deny', reason: decision.reason })
    return next()
  }
  const executed = []
  const denied = []
  async function call(name, args) {
    const decision = await handlers['tools/pre-execute'](
      { name, arguments: args },
      () => {
        executed.push({ name, args })
        return Promise.resolve({ kind: 'ok' })
      },
    )
    if (decision.kind === 'deny') denied.push({ name, args, reason: decision.reason })
    return decision
  }
  return { call, executed, denied }
}

// ---------- 真实会话序列：搜索 → 浏览结果 → 看详情 → 试图下载全文 ----------
test('真实会话：检索流程放行，下载尝试被拦且不触达执行器', async () => {
  let t = 0
  const p = buildPipeline({ now: () => t, minIntervalMs: 4000, maxCalls: 12, windowMs: 600000 })
  const steps = [
    ['browser_navigate', { url: 'https://kns.cnki.net/kns8s/defaultresult/index?dbcode=CFLS&kw=情势变更' }],
    ['browser_click', { selector: '#result-table .row:first-child' }],
    ['browser_navigate', { url: 'https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD&filename=FXJ202101001' }],
    ['browser_snapshot', {}],
  ]
  for (const [name, args] of steps) {
    t += 5000
    const d = await p.call(name, args)
    assert.equal(d.kind, 'ok', `${name} 应放行`)
  }
  assert.equal(p.executed.length, 4)

  // 第 5 步：AI 试图导航到下载端点拿全文
  t += 5000
  const d = await p.call('browser_navigate', {
    url: 'https://kns.cnki.net/kcms/download.aspx?filename=FXJ202101001.caj&dbcode=CJFD',
  })
  assert.equal(d.kind, 'deny')
  assert.ok(d.reason.includes('手动下载'))
  // 关键断言：被拦调用没有执行
  assert.equal(p.executed.length, 4)
  assert.equal(p.denied.length, 1)
})

// ---------- 逃逸向量 ----------
test('逃逸：URL 编码的下载端点被识别（kcms%2Fdownload）', () => {
  const decide = createCnkiGuard()
  const variants = [
    'https://kns.cnki.net/kcms%2Fdownload.aspx?filename=ABC.caj',
    'https%3A%2F%2Fkns.cnki.net%2Fkcms%2Fdownload.aspx%3Ffilename%3DABC.caj',
    'https://kns.cnki.net/kcms2/article/download?fn=X.pdf',
    'https%3A%2F%2Fkns.cnki.net%2Fkcms2%2Farticle%2Fdownload%3Ffn%3DX.pdf',
    'https://kns.cnki.net/kns8s/download%3Fdbcode%3DCJFD',
  ]
  for (const url of variants) {
    const d = decide('browser_navigate', { url })
    assert.equal(d.action, 'deny', url)
    assert.ok(d.reason.includes('手动下载'), url)
  }
})

test('逃逸：双层编码与 %2E 点编码的文件名被识别', () => {
  const decide = createCnkiGuard()
  const d1 = decide('browser_navigate', {
    url: 'https://kns.cnki.net/kcms/download.aspx?filename=ABC%252Ecaj',
  })
  assert.equal(d1.action, 'deny', '双层编码 %252E → %2E → .')
  const d2 = decide('browser_navigate', {
    url: 'https://kns.cnki.net/kcms/download.aspx?filename=ABC%2Ecaj',
  })
  assert.equal(d2.action, 'deny', '点编码 %2E')
})

test('逃逸：反斜杠路径分隔符被识别', () => {
  const decide = createCnkiGuard()
  assert.equal(decide('browser_navigate', { url: 'https://kns.cnki.net/kcms\\download.aspx?filename=A.caj' }).action, 'deny')
  // JSON.stringify 后的反斜杠（参数对象里是字面反斜杠）
  assert.equal(decide('browser_evaluate', { script: "fetch('https://kns.cnki.net/kcms\\\\download.aspx?filename=A.caj')" }).action, 'deny')
})

test('逃逸：大写 host 与混合大小写端点被识别', () => {
  const decide = createCnkiGuard()
  assert.equal(decide('browser_navigate', { url: 'HTTPS://KNS.CNKI.NET/KCMS/DOWNLOAD.ASPX?FILENAME=A.CAJ' }).action, 'deny')
})

test('逃逸：藏在嵌套参数 / 字符串参数里的下载 URL', () => {
  const decide = createCnkiGuard()
  assert.equal(
    decide('browser_click', { selector: 'a[href="https://kns.cnki.net/kcms/download.aspx?filename=A.pdf"]' }).action,
    'deny',
  )
  assert.equal(decide('browser_type', '帮我打开 https://kns.cnki.net/kcms/download.aspx?filename=A.nh').action, 'deny')
  assert.equal(
    decide('browser_evaluate', { script: "location.href='https://kns.cnki.net/bar/download/order'" }).action,
    'deny',
  )
})

test('误伤排查：正常学术 URL 不触发 deny', () => {
  const decide = createCnkiGuard({ now: () => 0, minIntervalMs: 0, maxCalls: 999 })
  const benign = [
    'https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD&filename=FXJ202101001',
    'https://kns.cnki.net/kns8s/defaultresult/index?kw=%E5%90%88%E5%90%8C',
    'https://kns.cnki.net/kns/brief/result.aspx?dbprefix=CJFQ',
    'https://navi.cnki.net/knavi/journals/ZGFX/detail',
    'https://kns.cnki.net/kns8s/AdvSearch?dbcode=CFLS',
    'https://oversea.cnki.net/kns/defaultresult/index?kw=law',
    'https://www.cnki.net/',
    // 详情页带 filename 参数但无 caj/pdf/nh 扩展名
    'https://kns.cnki.net/kcms/detail/detail.aspx?filename=FXJ202101001&dbcode=CJFD',
  ]
  for (const url of benign) {
    assert.equal(decide('browser_navigate', { url }).action, 'allow', url)
  }
})

// ---------- 混合流量下的限速与配额 ----------
test('混合流量：非知网调用穿插不消耗配额，知网计数正确', async () => {
  let t = 0
  const p = buildPipeline({ now: () => t, minIntervalMs: 0, maxCalls: 3, windowMs: 600000 })
  const knsi = { url: 'https://kns.cnki.net/kns8s/defaultresult/index?kw=x' }
  const other = { url: 'https://example.com/page' }
  await p.call('browser_navigate', other) // 不计数
  await p.call('browser_navigate', knsi) // 1
  await p.call('browser_navigate', other) // 不计数
  await p.call('browser_navigate', knsi) // 2
  await p.call('browser_navigate', other)
  await p.call('browser_navigate', knsi) // 3
  t = 1000
  const d = await p.call('browser_navigate', knsi) // 第 4 次 → 拒
  assert.equal(d.kind, 'deny')
  assert.ok(d.reason.includes('cnki_parse_export'))
  assert.equal(p.denied.length, 1)
  // 非知网仍放行
  t = 2000
  assert.equal((await p.call('browser_navigate', other)).kind, 'ok')
})

test('限速与配额同时约束：间隔优先于配额提示', async () => {
  let t = 0
  const p = buildPipeline({ now: () => t, minIntervalMs: 4000, maxCalls: 12, windowMs: 600000 })
  await p.call('browser_navigate', { url: 'https://kns.cnki.net/kns8s/x?kw=1' })
  t = 1000
  const d = await p.call('browser_navigate', { url: 'https://kns.cnki.net/kns8s/x?kw=2' })
  assert.equal(d.kind, 'deny')
  assert.ok(d.reason.includes('频繁'), '间隔不足时提示频繁而非配额')
})

test('下载拦截不消耗限速配额（deny 在计数之前返回）', async () => {
  let t = 0
  const p = buildPipeline({ now: () => t, minIntervalMs: 0, maxCalls: 1, windowMs: 600000 })
  // 连续多次下载尝试：全部 deny，且不会把配额占掉
  for (let i = 0; i < 5; i++) {
    const d = await p.call('browser_navigate', { url: `https://kns.cnki.net/kcms/download.aspx?filename=F${i}.caj` })
    assert.equal(d.kind, 'deny')
  }
  // 唯一的配额仍在，正常检索页可访问
  t = 1000
  assert.equal((await p.call('browser_navigate', { url: 'https://kns.cnki.net/kns8s/x?kw=a' })).kind, 'ok')
})

// ---------- 执行 ----------
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
