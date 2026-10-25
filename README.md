# dsh-plugin-cnki-assist

中国知网（CNKI）文献工作流助手，面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)。为法学等文科文献综述场景提供两个工具、一层守护和一个技能：

| 组件 | 类型 | 作用 |
|---|---|---|
| `cnki_search_url` | 工具 | 把大白话需求变成知网检索链接：简单关键词 → 结果页直链；专业检索式 → 专业检索页链接。附法学检索策略提示（CSSCI 筛选、被引排序等） |
| `cnki_parse_export` | 工具 | 解析知网"导出文献"生成的题录 txt（支持自定义 / EndNote / RefWorks / 制表符格式，UTF-8 与 GB18030 编码），返回结构化论文列表 |
| 知网访问守护 | 门禁 | `tools/pre-execute` 钩子：**拦截一切指向知网下载端点的浏览器调用**（CAJ/PDF/整本下载），并对知网访问限速（默认 12 次/10 分钟、间隔 ≥4 秒），超限自动引导降级到人工导出链路 |
| `cnki-search` | 技能 | 教会 agent 完整合规检索工作流：多角度检索式 → 浏览器打开结果页 → 只读题录 → 综合排序输出，含验证码/登录页处置与降级链路 |

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
node test/run.mjs   # 11 项纯逻辑测试，无外部依赖
```

源码结构：`index.js`（工具注册）→ `lib/url.js`（URL 构造）→ `lib/parse-export.js`（编码识别与多格式解析）。

## License

MIT
