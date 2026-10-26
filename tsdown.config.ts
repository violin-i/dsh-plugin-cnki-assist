import { defineConfig } from 'tsdown'

// 浏览器模块表中由宿主注入的平台模块：bundle 必须留给 require
const PLATFORM_MODULES = ['react']

export default defineConfig([
  {
    // 宿主半（工作台面板路由）：同名输出 lib/workbench.js，经 exports["./workbench"] 提供
    name: 'law-workbench-host',
    entry: { workbench: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    minify: false,
    dts: false,
    clean: false,
  },
  {
    // 浏览器半（面板 bundle）：输出 lib/client.js，经 exports["./client"] 与 dsh.client 声明加载。
    // id 必须等于包名（WebBootEntry: Entry name == package name）
    name: 'dsh-plugin-cnki-assist',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: false,
    clean: false,
    minify: false,
    deps: {
      neverBundle: (specifier: string) => PLATFORM_MODULES.includes(specifier),
    },
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': '{}',
    },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (PLATFORM_MODULES.includes(source)) return null
          throw new Error(
            `client bundle purity: "${source}" 不得在浏览器 bundle 中引用；跨插件协作请走 cordis 服务`,
          )
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-plugin-cnki-assist')}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
