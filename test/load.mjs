// 加载验证：node test/load.mjs
// 用真实的 @deepseek-ai/dsh-tools 驱动 defineTool 的 schema 编译，
// 并以 stub 的 tools 服务验证 apply() 注册路径。
import assert from 'node:assert/strict'

const registered = []
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool)
    },
  },
}

const mod = await import('../index.js')
assert.equal(mod.name, 'cnki-assist', '插件 name 导出正确')
assert.deepEqual(mod.inject, ['tools'], 'inject 声明正确')
assert.equal(typeof mod.apply, 'function', 'apply 是函数')

mod.apply(ctx)

assert.equal(registered.length, 2, '注册了两个工具')
const names = registered.map((t) => t.name)
assert.deepEqual(names.sort(), ['cnki_parse_export', 'cnki_search_url'])

for (const tool of registered) {
  assert.ok(tool.description && tool.description.length > 20, `${tool.name} 有描述`)
  assert.ok(tool.parameters, `${tool.name} 有参数 schema`)
  assert.ok(tool.output && tool.output.schema, `${tool.name} 有输出 schema`)
}

// 快速执行一次真实工具逻辑（不触网）
const urlTool = registered.find((t) => t.name === 'cnki_search_url')
const result = await urlTool.execute({ query: '测试' })
assert.equal(result.mode, 'keyword')
assert.ok(result.url.startsWith('https://kns.cnki.net/kns8s/defaultresult/index'))

console.log('PASS 插件加载与工具注册验证（真实 dsh-tools schema 编译 + 执行）')
console.log(`     注册工具: ${names.join(', ')}`)
