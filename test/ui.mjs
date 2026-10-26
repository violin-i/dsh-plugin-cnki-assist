// UI 双侧测试：node test/ui.mjs（需先 pnpm run build 生成 lib/workbench.js 与 lib/client.js）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(dir, '..')
const require = createRequire(join(pkgRoot, 'package.json'))

let passed = 0
let failed = 0
function report(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.error(`FAIL ${name}\n  ${detail}`)
  }
}

// ---------- 共享文献库测试数据 ----------
const tmp = mkdtempSync(join(tmpdir(), 'lwb-'))
const libDir = join(tmp, 'law-library')
mkdirSync(libDir, { recursive: true })
writeFileSync(
  join(libDir, 'library.json'),
  JSON.stringify({
    version: 1,
    nextId: 3,
    papers: [
      {
        id: 'p1',
        title: '论效力性强制性规定的识别标准',
        path: 'D:/papers/a.pdf',
        pages: 14,
        addedAt: '2026-10-26T10:00:00.000Z',
        text: '效力性强制性规定与管理性强制性规定的区分是司法实践的难点。本文从规范目的、法益衡量与体系解释三个维度建构识别标准。'.repeat(10),
        chunks: [
          '效力性强制性规定与管理性强制性规定的区分是司法实践的难点。',
          '本文从规范目的、法益衡量与体系解释三个维度建构识别标准。',
        ],
      },
      {
        id: 'p2',
        title: '情势变更原则研究',
        path: 'D:/papers/b.pdf',
        pages: 22,
        addedAt: '2026-10-26T11:00:00.000Z',
        text: '情势变更与商业风险的界分。'.repeat(30),
        chunks: ['情势变更与商业风险的界分是司法实践难点。', '本文提出类型化标准。'],
      },
    ],
  }),
)

// ---------- 宿主半 ----------
try {
  const host = await import(pathToFileURL(join(pkgRoot, 'lib', 'workbench.js')).href)
  const routes = new Map()
  const stubCtx = {
    get: (name) =>
      name === 'connection'
        ? {
            fetch: {
              register: (route) => {
                routes.set(route.path, route)
                return () => routes.delete(route.path)
              },
            },
          }
        : undefined,
    effect: (fn) => fn(),
    logger: { warn() {} },
  }
  host.apply(stubCtx, { libraryDir: libDir })
  assert.equal(routes.size, 7, '注册 7 个路由')

  const stateRes = await routes.get('/api/law-workbench/state').fetch(new Request('http://x/api/law-workbench/state', { method: 'POST' }))
  const state = await stateRes.json()
  assert.equal(state.count, 2)
  assert.equal(state.papers[0].id, 'p1')
  assert.equal(state.papers[0].chunks, 2)
  report('宿主半：state 路由返回文献列表', true)

  const searchRes = await routes
    .get('/api/law-workbench/search')
    .fetch(new Request('http://x/api/law-workbench/search', { method: 'POST', body: JSON.stringify({ query: '效力性强制性规定 识别标准' }) }))
  const search = await searchRes.json()
  assert.ok(search.results.length >= 1)
  assert.equal(search.results[0].paper_id, 'p1')
  assert.ok(search.results[0].snippet.length > 0)
  report('宿主半：search 路由 BM25 命中正确文献', true)

  // 概念扩展：query 用"合同无效"，p1 只出现"效力性强制性规定"（同义词表关联）
  const expRes = await routes
    .get('/api/law-workbench/search')
    .fetch(new Request('http://x/api/law-workbench/search', { method: 'POST', body: JSON.stringify({ query: '合同无效' }) }))
  const exp = await expRes.json()
  assert.ok(exp.expanded.length >= 1, '返回扩展词')
  assert.ok(exp.results.some((r) => r.paper_id === 'p1'), '扩展后命中 p1')
  assert.ok(exp.results.some((r) => r.snippet.includes('【')), '片段带高亮标记')
  report('宿主半：概念扩展 + 高亮', true)

  const readRes = await routes
    .get('/api/law-workbench/read')
    .fetch(new Request('http://x/api/law-workbench/read', { method: 'POST', body: JSON.stringify({ paper_id: 'p1', offset: 0, limit: 50 }) }))
  const read = await readRes.json()
  assert.equal(read.title, '论效力性强制性规定的识别标准')
  assert.equal(read.text.length, 50)
  assert.equal(read.has_more, true)
  report('宿主半：read 路由窗口阅读', true)

  const missRes = await routes
    .get('/api/law-workbench/read')
    .fetch(new Request('http://x/api/law-workbench/read', { method: 'POST', body: JSON.stringify({ paper_id: 'nope' }) }))
  assert.equal(missRes.status, 404)
  report('宿主半：404 处理', true)

  // 大纲
  const outlineRes = await routes
    .get('/api/law-workbench/outline')
    .fetch(new Request('http://x/api/law-workbench/outline', { method: 'POST', body: JSON.stringify({ paper_id: 'p1' }) }))
  const outline = await outlineRes.json()
  assert.equal(outline.id, 'p1')
  assert.ok(Array.isArray(outline.headings))
  report('宿主半：outline 路由', true)

  // 笔记增查删
  const addRes = await routes
    .get('/api/law-workbench/note')
    .fetch(
      new Request('http://x/api/law-workbench/note', {
        method: 'POST',
        body: JSON.stringify({ paper_id: 'p1', quote: '规范目的、法益衡量与体系解释', comment: '三要素框架，综述核心' }),
      }),
    )
  const added = await addRes.json()
  assert.ok(added.note.id, 'add 返回 note')
  const listRes = await routes
    .get('/api/law-workbench/notes')
    .fetch(new Request('http://x/api/law-workbench/notes', { method: 'POST', body: JSON.stringify({ paper_id: 'p1' }) }))
  const list = await listRes.json()
  assert.equal(list.notes.length, 1)
  assert.equal(list.notes[0].comment, '三要素框架，综述核心')
  const delRes = await routes
    .get('/api/law-workbench/note')
    .fetch(
      new Request('http://x/api/law-workbench/note', {
        method: 'POST',
        body: JSON.stringify({ action: 'remove', paper_id: 'p1', note_id: added.note.id }),
      }),
    )
  const del = await delRes.json()
  assert.equal(del.removed, true)
  report('宿主半：笔记增查删', true)

  // 空批注拒绝
  const badRes = await routes
    .get('/api/law-workbench/note')
    .fetch(new Request('http://x/api/law-workbench/note', { method: 'POST', body: JSON.stringify({ paper_id: 'p1', comment: ' ' }) }))
  assert.equal(badRes.status, 400)
  report('宿主半：空批注 400', true)

  // 阅读进度
  const progRes = await routes
    .get('/api/law-workbench/progress')
    .fetch(new Request('http://x/api/law-workbench/progress', { method: 'POST', body: JSON.stringify({ paper_id: 'p1', offset: 300 }) }))
  const prog = await progRes.json()
  assert.equal(prog.progress.offset, 300)
  // state 应带出进度与笔记数字段
  const state2Res = await routes.get('/api/law-workbench/state').fetch(new Request('http://x/api/law-workbench/state', { method: 'POST' }))
  const state2 = await state2Res.json()
  assert.equal(state2.papers[0].progress.pct, Math.round((300 / state2.papers[0].chars) * 100))
  assert.equal(state2.papers[0].notes, 0)
  report('宿主半：进度保存 + state 汇总', true)
} catch (e) {
  report('宿主半', false, e.message)
}

// ---------- 浏览器半 ----------
try {
  const code = await import('node:fs').then((fs) => fs.readFileSync(join(pkgRoot, 'lib', 'client.js'), 'utf8'))
  let entry = null
  const loader = { load: (e) => (entry = e) }
  const sandboxWindow = { __ModuleLoader__: loader }
  new Function('window', code)(sandboxWindow)
  assert.ok(entry, 'ModuleLoader.load 被调用')
  assert.equal(entry.id, 'dsh-plugin-cnki-assist')

  // 用 react-dom 自己解析到的 react 实例喂给 factory，避免双实例导致 hook 报错
  const domEntryPath = require.resolve('react-dom/server')
  const domRequire = createRequire(domEntryPath)
  const reactInstance = domRequire('react')
  const exports = entry.factory((spec) => {
    if (spec === 'react') return reactInstance
    throw new Error('意外的 require: ' + spec)
  })
  assert.equal(exports.name, 'law-workbench-client')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.__Panel, 'function')
  report('浏览器半：bundle 通过 ModuleLoader 协议加载', true)

  // apply 注册侧边栏 tab 与正文坑位
  const reg = { tabs: [], slots: [] }
  const fakeCtx = {
    inject: (deps, cb) => {
      assert.deepEqual(deps, ['sidebarRightTabs'])
      const raw = {
        sidebarRightTabs: { register: (d) => (reg.tabs.push(d), () => {}) },
        slots: {
          inject: (name, setup) => (setup(), () => {}),
          register: (d, comp) => (reg.slots.push({ d, comp }), () => {}),
        },
      }
      const dispose = cb(raw)
      return { dispose }
    },
  }
  exports.apply(fakeCtx)
  assert.equal(reg.tabs.length, 1)
  assert.equal(reg.tabs[0].kind, 'law-workbench')
  assert.equal(reg.tabs[0].title(), '工作台')
  assert.equal(reg.tabs[0].guide.length, 1)
  assert.equal(reg.slots.length, 1)
  assert.equal(reg.slots[0].d.name, 'sidebar.right.pane.tab')
  assert.equal(reg.slots[0].d.key, 'dsh-plugin-law-workbench')
  assert.equal(typeof reg.slots[0].comp, 'function')
  report('浏览器半：侧边栏 tab + 正文坑位注册', true)

  // 面板可渲染：renderToString 与 react 从同一 react-dom 位置解析，确保实例配对
  const renderToString = domRequire('react-dom/server').renderToString
  const html = renderToString(reactInstance.createElement(exports.__Panel))
  assert.ok(html.includes('工作台'), '面板标题渲染')
  assert.ok(html.includes('检索文献库'), '搜索框渲染')
  report('浏览器半：Panel 组件 SSR 渲染无异常', true)
} catch (e) {
  report('浏览器半', false, e.message)
}

// 清理
rmSync(tmp, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
