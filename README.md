# dsh-arxiv · arXiv 速读

> DeepSeek Harness 的 arXiv 阅读器：**左侧插件栏的全局面板**，不绑定某个 Session。
> 粘一个 arXiv ID，左边 AI 速览/追问、右边按论文章节排版的原文（标题/正文/列表/表格/图/公式）。
> 把论文挂到会话后，该会话里的 agent 也能看到并读取这篇论文。

- GitHub：<https://github.com/LyuYuxin/dsh-arxiv>
- npm：<https://www.npmjs.com/package/dsh-arxiv>（npm 上目前是旧版 0.1.1；v0.2/v0.3 请用 GitHub 源码安装）

## 功能

- **左侧栏全局面板**：侧栏 arXiv 图标进入阅读面板；和 Plugins 页同级，切换/新建会话都不影响，
  阅读进度、论文库全局保留。
- **论文按排版读，不是一坨纯文本**（v0.3）：从 ar5iv/arXiv HTML 抽取结构化文档——标题层级、段落、
  列表、表格、插图、公式，按阅读顺序渲染；带章节目录（TOC）、图片代理（防防盗链）、公式块，
  可一键切“纯文本”对照。排版参考了 opendataloader-pdf 的“结构 + 阅读顺序”思路。
- **大工作区、可拖拽双栏**：AI 默认占一半，与论文区同一屏；中间分隔条可拖动（双击回到 50/50），
  宽度比例会记住；窄屏自动上下排。AI 区「AI 速览 / 追问」分页，速览是一张大的可读卡片，
  追问是接近全屏的对话 + 底部输入框。
- **原文 + AI 一起看**：流式中文速览（一句话总结 / 核心贡献 / 方法 / 实验与结果 / 局限性 / 谁该读）
  与多轮追问；原文栏可复制、可划选后「问选中段落」。
- **论文库**：最近导入与收藏（★）持久化；重开面板自动回到上次那篇论文，速览按“论文+模型”缓存。
- **与会话联通**：
  - 顶部选择**目标会话**（默认最近更新的会话），AI 使用该会话当前模型，也可在面板里切模型；
  - 一键 **挂到会话**：把论文关联到目标会话；
  - 挂载后，该会话的 agent 下一步起会收到一条精简上下文（标题/ID/分类/摘要/章节提示），
    并可调用 **`arxiv` 工具**（`current / meta / abstract / sections / read / search`）按需读取正文，
    回答能引用章节，不需要你把论文贴进对话；
  - **发给 agent**：把当前论文写进目标会话的输入并回到会话（自动先挂载）；
  - **问选中段落**：在原文里划选一段，连同问题一起发给 agent。
- **快**：元信息 + 全文 + 结构化文档并行抓取；结构化失败自动降级为自动提取文本；全文抓不到先出
  “仅摘要”速览，晚到可一键用全文重写；速览请求自动用模型最低 reasoning effort；全程流式。
- **无 npm 依赖**：Host 只增加能力（doc/img/attach 路由、`arxiv` 工具、agent 上下文注入），
  自研轻量 HTML 解析器抽取论文结构。

## 安装（另一台电脑）

前提：已安装并登录 DeepSeek Harness（桌面端至少启动过一次），需要 v0.2.1-rc 系列。

**方式：从 GitHub 源码安装（v0.3.0 推荐）**

```powershell
git clone https://github.com/LyuYuxin/dsh-arxiv.git
cd dsh-arxiv
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 装到别的 profile（例如 dsh web）：-ProfileName web
# 然后重启 DeepSeek Harness
```

npm 方式（旧版 0.1.1，仅当你想用最早的单篇阅读版本）：

```powershell
dsh plugin --profile desktop add dsh-arxiv
```

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-arxiv
# 再从 %USERPROFILE%\.dsh\profiles\desktop\package.json 的 dsh.profile.bundles 里删掉 "dsh-arxiv"，重启
```

## 使用

1. 点左侧栏 **arXiv** 图标 → 面板。
2. 顶部选择**目标会话**（默认最近会话；没会话时仍可阅读，但 AI/挂载/发送不可用）。
3. 粘贴 arXiv ID 回车；AI 速览自动开始，右侧同时抓取并渲染结构化原文。
4. 需要 agent 帮忙时：点 **挂到会话**，然后直接在会话里问（agent 已能看到这篇论文并可调用
   `arxiv` 工具读正文）；或点 **发给 agent**；或选中原文片段点 **问选中段落**。
5. 模型选择器切换目标会话的模型；速览/问答用它，agent 的下一步请求也会用新模型。
6. 「论文库」点历史论文可直接重开；★ 收藏。阅读区默认 50/50，可拖分隔条调整。

## 实现

| 文件 | 作用 |
|---|---|
| `index.js` | Host：`/health` `/meta` `/text`(支持 `body=1`) `/ai`(SSE) `/attach` `/doc`(结构化文档) `/img`(图片代理)；注册 `arxiv` 工具和 `agent/pre-step` 上下文注入 |
| `src/paper.mjs` | 轻量 HTML 解析 + 结构化抽取（heading/paragraph/list/table/figure/equation/quote）、图片绝对化、摘要兜底 |
| `src/attach.mjs` | attach 存储（内存 LRU 50）、手写 `arxiv` ToolDefinition、pre-step 注入文本 |
| `src/arxiv.mjs` | arXiv ID 解析、元信息、全文抓取与 HTML→纯文本（ar5iv 优先，arXiv HTML/仅摘要降级） |
| `src/prompt.mjs` | 速览/问答 prompt 与文本预算 |
| `client.js` | 浏览器侧：`sidebar.panellist` 图标 + `main` keyed 面板；全局库/会话选择/挂载/发送；可拖拽双栏、AI 分页、结构化论文渲染 |
| `cordis.patch.yml` | 插件在 profile 中的 Loader 行 |
| `test/` | 离线单测（`npm test`）：解析/提取/prompt/Host 路由/SSE/attach/工具/注入/doc/img |
| `tools/` | 隔离 `dsh web` 实例 + HTTP/DOM/真浏览器端到端验证（开发用） |

模型可见的三条契约：

```text
attach:  POST /dsh-arxiv/attach {sessionId, paperId|null}   GET /dsh-arxiv/attach?sessionId=
doc:     GET  /dsh-arxiv/doc?id=        -> {ok, source, sections, blocks[{type,...}]}
img:     GET  /dsh-arxiv/img?src=<absolute ar5iv/arxiv https url>
tool:    arxiv(action=current|meta|abstract|sections|read|search, id?, section?, query?, offset?, limit?)
context: agent/pre-step 时，若 session 挂了论文，注入一条精简上下文（同篇 10 分钟内不重复）
```

## 开发与验证

```powershell
npm test                       # 离线单测
node tools/install-dev.mjs     # 隔离 DSH_HOME（%TEMP%\dsh-arxiv-dev）安装插件
node tools/boot.mjs            # 起隔离 dsh web，打印 http://127.0.0.1:<port>/
node tools/e2e.mjs --http-only # 无浏览器：Host/SSE/attach/doc/img + boot manifest
node tools/client-dom.mjs      # happy-dom + React 挂载真实 client.js，驱动面板/结构化渲染/拖拽/速览/问答/模型/attach/发送
node tools/e2e.mjs             # 完整 Playwright（真浏览器，需普通终端）
```

## 数据与隐私

- 论文元信息、全文与图片直接取自 arXiv / ar5iv，不经过第三方服务；图片经 Host 代理只为绕过防盗链，
  允许列表限定 ar5iv/arxiv 域名。
- 生成速览/问答时，论文文本会发给你在 DSH 里选择的模型提供方（与正常对话一致）。
- 挂载的论文 ID 只保存在 Host 进程内存里；论文库/上次阅读/模型选择只存浏览器 `localStorage`。

## 已知限制

- 只做**单篇**快速阅读：没有检索、推荐、引用图谱，也不做整篇翻译。
- 结构化抽取是通用启发式：极复杂版面（跨页大表、复杂公式）可能降级/丢格式；公式保留 LaTeX 源码，
  不做 KaTeX 渲染；图表请以 arXiv HTML/PDF 为准。
- 超长论文只渲染前 2000 个 block / 纯文本前 15 万字。
- 挂载关系是进程内内存（Host 重启后需在面板重新点一次“挂到会话”）；论文库与面板状态在浏览器本地。
- 需要目标会话里至少有一个可用模型；没有会话时只能阅读，不能 AI 总结/问答/挂载/发送。
- 依赖 DSH 0.2.1-rc 系列（`sidebar.panellist` / `main` / `layout` / `sessions` / `modelDirectories` 等公开客户端约定）。

## License

MIT © Lyu Yuxin
