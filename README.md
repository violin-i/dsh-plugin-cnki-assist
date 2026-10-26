# dsh-plugin-cnki-assist

中国知网（CNKI）法学文献工作台，面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)。覆盖"找文献 → 筛文献 → 读文献 → 写综述"全链路：两个检索工具 + 一层访问守护 + 一个本地文献库（8 个工具）+ 两个技能。

| 组件 | 类型 | 作用 |
|---|---|---|
| `cnki_search_url` | 工具 | 把大白话需求变成知网检索链接：简单关键词 → 结果页直链；专业检索式 → 专业检索页链接。附法学检索策略提示（CSSCI 筛选、被引排序等） |
| `cnki_parse_export` | 工具 | 解析知网"导出文献"生成的题录 txt（自定义双语标签 / EndNote / RefWorks / 制表符，UTF-8 与 GB18030，含 `\0` 清理），返回结构化论文列表 |
| 知网访问守护 | 门禁 | `tools/pre-execute` 钩子：拦截指向知网下载端点的浏览器调用（kcms/download、bar/download 等），并限速（默认 12 次/10 分钟、间隔 ≥4 秒），超限自动引导降级到人工导出链路 |
| `cnki-search` | 技能 | 合规检索工作流：多角度检索式 → 浏览器打开结果页 → 只读题录 → 综合排序输出，含验证码处置、降级链路与精确到按钮的导出步骤 |
| `law_lib_add` / `list` / `search` / `read` / `citation` / `remove` | 工具（文献库） | 本地文献库：PDF/TXT 入库（pdfjs 中文提取、哈希去重、扫描版拒收提示）、中文 BM25 全文检索（法律概念扩展 + 命中词高亮）、大纲/窗口式阅读（可存阅读进度）、《法学引注手册》与 GB/T 7714 引注生成、移除 |
| `law_lib_note` / `law_lib_related` | 工具（文献库） | 综述闭环：摘录+批注笔记（随库持久化）；基于标题+开篇 BM25 交叉打分的相关文献推荐（附共现概念词） |
| `law-workbench` | 技能 | 文献库工作流：单篇精读卡片（论点/论证路径/方法/可引原文）、观点谱系对比、综述草稿规范、引注元数据补全提示 |

文献库为**纯本地**实现：BM25 检索（中文 bigram + 内置法律概念同义表扩展）+ 文件型存储（默认 `~/.dsh/law-library/`，可经 profile 的行配置 `libraryDir` 覆盖；v2 格式含笔记与阅读进度，自动兼容 v1），零网络、零 API key、零向量模型——个人文献库规模（几十到上百篇）下检索即时返回，全文不出本机。唯一依赖 `pdfjs-dist` 为纯 JS 包，无构建脚本、无原生模块。

## 文献库使用

```text
你：把 D:\论文\合同无效 这个文件夹里的 PDF 都入库
AI：law_lib_add → 入库 8 篇

你：总结第一篇的核心论证
AI：law_lib_read(outline) → 分窗通读 → 输出读书卡片

你：这几篇在"识别标准"上观点有什么分歧？
AI：law_lib_search(每个争点一轮) → 观点谱系表（标注 [id] 与 chunk 位置）

你：这一段值得摘录，批注"与王利明观点相左"
AI：law_lib_note(action=add, quote, comment) → 笔记入库（law_lib_related 找同主题文献一起读）

你：生成综述初稿，引注用法学引注手册
AI：分节取材 → law_lib_citation 逐篇引注 → 综述草稿（〔待补〕字段提醒核对）
```

## 浏览器自动检索（可选增强）

安装浏览器提供方后，agent 可以在对话里直接执行检索并把结果整理成清单返回：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-browser-use-playwright-mcp   # 或其他 browser-use 提供方
npx playwright install chromium
```

使用前提：本机在校园网或学校 VPN 环境下。守护插件在代码层强制"只读题录、永不下载全文、人工节奏访问"三条红线，被拦截时 agent 会收到明确的降级指引。

**设计边界**：本插件不访问知网、不抓取网页、不下载全文。在知网页面上的检索、勾选、导出、下载由使用者在校园网/学校 VPN 环境下手动完成——这是对学校订阅合规使用的底线。插件只负责把前后两端自动化：生成检索入口，消化导出结果。

## 安装

前置：已安装 Node.js（≥18）与 dsh CLI。三种方式任选：

```sh
# 方式一：从 GitHub 安装（本包为纯 JS、无构建脚本，无需 allowBuilds 授权）
dsh plugin --profile web add github:violin-i/dsh-plugin-cnki-assist

# 方式二：从本地路径安装（开发/内测）
dsh plugin --profile web add ./dsh-plugin-cnki-assist

# 方式三：tarball（无网络环境分发）
pnpm pack && dsh plugin --profile web add ./dsh-plugin-cnki-assist-0.1.0.tgz
```

启动：`dsh web`，打开 `http://127.0.0.1:3080`。可用 `dsh --profile web --dump-config` 确认出现 `# == dsh-plugin-cnki-assist` 层。

适配版本：dsh `>=0.2.0 <0.3.0`（开发者预览期，破坏性变更风险自担）。

## 使用

对话示例：

> 帮我找关于"效力性强制性规定与合同无效"的核心期刊论文

模型会先调用 `cnki_search_url` 生成专业检索式与知网链接；你打开链接（需校园网），在结果页勾选文献 → **导出文献 → 自定义（勾选摘要字段）→ 导出为 txt**，把文件放到本地，然后：

> 解析 D:/文献/导出.txt，按相关度排序，每篇一句话摘要，标出值得精读的

模型调用 `cnki_parse_export` 拿到结构化列表后自行完成排序与摘要。

## 开发与测试

```sh
node test/run.mjs      # 12 项纯逻辑测试（URL/题录解析），无外部依赖
node test/phase3.mjs   # 13 项文献库测试（分块/BM25/PDF/引注/工具注册）
node test/phase4.mjs   # 14 项 v0.4 测试（概念扩展/高亮/相关推荐/笔记/进度/v1 兼容）
```

源码结构：`index.js`（工具注册）→ `lib/url.js`（URL 构造）→ `lib/parse-export.js`（编码识别与多格式解析）→ `lib/collection.js`（文献库核心：分块、BM25、概念扩展、笔记与进度）→ `library.js`（文献库工具注册）。

## License

MIT
