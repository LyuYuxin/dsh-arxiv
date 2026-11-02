# dsh-arxiv · arXiv 速读

> DeepSeek Harness 的 arXiv 阅读器：**左侧插件栏的全局面板**，不绑定某个 Session；粘一个 arXiv ID，
> 左边 AI 速览/问答、右边原文。把论文“挂到会话”后，该会话里的 agent 也能看到并读取这篇论文。

- npm：<https://www.npmjs.com/package/dsh-arxiv>
- GitHub：<https://github.com/LyuYuxin/dsh-arxiv>

## 功能

- **左侧栏全局面板**：侧栏新增 arXiv 图标，点开进入阅读面板；和 Plugins 页同级，切换会话/新建会话都不影响，
  阅读中的论文和论文库全局保留。
- **只要一个 arXiv ID**：`2401.12345`、`arXiv:2401.12345v2`、`arxiv.org/abs/…`、`pdf/…pdf` 都能直接粘。
- **原文 + AI 一起看**：AI 栏是流式中文速览（一句话总结 / 核心贡献 / 方法 / 实验与结果 / 局限性 / 谁该读）
  和多轮追问；原文栏是从 arXiv/ar5iv 提取的正文。顶部切换 **并排 / 只看 AI / 只看原文**，原文可复制、可选中提问。
- **论文库**：最近导入与收藏（★）持久化；重开面板自动回到上次那篇论文，速览按“论文+模型”缓存。
- **与会话联通（核心）**：
  - 面板顶部选择**目标会话**（默认最近更新的会话），AI 使用该会话当前模型，也可在面板里切模型；
  - 一键 **挂到会话**：把论文关联到目标会话；
  - 挂载后，该会话的 agent 在下一步起会收到一条精简上下文（论文标题/ID/分类/摘要/章节提示），
    并可调用 **`arxiv` 工具**（`current / meta / abstract / sections / read / search`）按需读取正文片段，
    回答时能引用章节，不需要你把论文贴进对话；
  - **发给 agent**：把当前论文写进目标会话的输入并回到会话（自动先挂载）；
  - **问选中段落**：在原文里划选一段，连同问题一起发给 agent。
- **快**：arXiv 摘要页元信息 + ar5iv 全文并行；全文抓不到时先出“仅摘要”速览、晚到可一键用全文重写；
  速览请求自动用模型最低 reasoning effort；全部流式输出。
- **极简**：无 npm 依赖、无后台任务；Host 只增加 3 类能力（attach 路由、arxiv 工具、agent 上下文注入）。

## 安装（另一台电脑）

前提：已安装并登录 DeepSeek Harness（桌面端至少启动过一次），需要 v0.2.1-rc 系列。

**方式 A：从 npm 安装（推荐）**

```powershell
dsh plugin --profile desktop add dsh-arxiv
# 找不到 dsh 命令时用桌面端自带的：
# & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-arxiv
# 然后重启 DeepSeek Harness
```

**方式 B：从 GitHub 源码安装**

```powershell
git clone https://github.com/LyuYuxin/dsh-arxiv.git
cd dsh-arxiv
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 装到别的 profile（例如 dsh web）：-ProfileName web
```

重启后，**左侧栏**会出现 arXiv 图标；点开即可用（不再依赖某个会话的视图标签栏）。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-arxiv
# 再从 %USERPROFILE%\.dsh\profiles\desktop\package.json 的 dsh.profile.bundles 里删掉 "dsh-arxiv"，重启
```

## 使用

1. 点左侧栏 **arXiv** 图标 → 面板。
2. 顶部选择**目标会话**（默认最近会话；没会话时仍可阅读，但 AI/挂载/发送不可用）。
3. 粘贴 arXiv ID 回车；AI 速览自动开始，原文栏同时加载。
4. 需要 agent 帮忙时：点 **挂到会话**，然后直接在会话里问（agent 已能看到这篇论文，并可调用 `arxiv` 工具读正文）；
   或点 **发给 agent** 把“我正在读这篇论文”写进输入框；或选中原文片段点 **问选中段落**。
5. 右上角模型选择器切换目标会话的模型；速览/问答用它，agent 的下一步请求也会用新模型。
6. 「论文库」里点历史论文可直接重开；★ 收藏。

## 实现

| 文件 | 作用 |
|---|---|
| `index.js` | Host：`/health` `/meta` `/text`(支持 `body=1` 回传正文) `/ai`(SSE) `/attach`，注册 `arxiv` 工具和 `agent/pre-step` 上下文注入 |
| `src/attach.mjs` | attach 存储（内存 LRU 50）、手写 `arxiv` ToolDefinition、pre-step 注入文本 |
| `client.js` | 浏览器侧：`sidebar.panellist` 图标 + `main` keyed 面板；全局库/会话选择/挂载/发送/原文+AI 双栏 |
| `src/arxiv.mjs` | arXiv ID 解析、元信息、全文抓取与 HTML→纯文本（ar5iv 优先，arXiv HTML/仅摘要降级） |
| `src/prompt.mjs` | 速览/问答 prompt 与文本预算 |
| `cordis.patch.yml` | 插件在 profile 中的 Loader 行 |
| `test/` | 离线单测（`npm test`）：arXiv 解析/提取、prompt、Host 路由/SSE/attach/工具/注入 |
| `tools/` | 隔离 `dsh web` 实例 + HTTP/DOM 端到端验证（开发用） |

模型可见的三条契约：

```text
attach:  POST /dsh-arxiv/attach {sessionId, paperId|null}   GET /dsh-arxiv/attach?sessionId=
tool:    arxiv(action=current|meta|abstract|sections|read|search, id?, section?, query?, offset?, limit?)
context: agent/pre-step 时，若 session 挂了论文，注入一条精简上下文（同篇 10 分钟内不重复）
```

## 开发与验证

```powershell
npm test                       # 离线单测
node tools/install-dev.mjs     # 隔离 DSH_HOME（%TEMP%\dsh-arxiv-dev）安装插件
node tools/boot.mjs            # 起隔离 dsh web，打印 http://127.0.0.1:<port>/
node tools/e2e.mjs --http-only # 无浏览器：Host/SSE/attach + boot manifest
node tools/client-dom.mjs      # happy-dom + React 挂载真实 client.js，驱动面板/导入/速览/问答/模型/原文/attach/发送
node tools/e2e.mjs             # 完整 Playwright（需普通终端；DSH 沙箱内无法启动 Chromium）
```

## 数据与隐私

- 论文元信息与全文直接取自 arXiv（`arxiv.org` / `ar5iv.labs.arxiv.org`），不经过第三方服务。
- 生成速览/问答时，论文文本会发给你在 DSH 里选择的模型提供方（与正常对话一致）。
- 挂载的论文 ID 只保存在 Host 进程内存里；论文库/上次阅读/模型选择只存浏览器 `localStorage`。

## 已知限制

- 只做**单篇**快速阅读：没有检索、推荐、引用图谱，也不做整篇翻译。
- 原文是自动提取的纯文本：公式/图表/排版以 arXiv HTML/PDF 为准；超长论文只渲染前 15 万字。
- ar5iv 未收录的论文降级为“仅摘要”，原文栏只显示摘要。
- 挂载关系是进程内内存（Host 重启后需在面板重新点一次“挂到会话”）；论文库与面板状态在浏览器本地。
- 需要目标会话里至少有一个可用模型；没有会话时只能阅读，不能 AI 总结/问答/挂载/发送。
- 依赖 DSH 0.2.1-rc 系列（`sidebar.panellist` / `main` / `layout` / `sessions` / `modelDirectories` 等公开客户端约定）。

## License

MIT © Lyu Yuxin
