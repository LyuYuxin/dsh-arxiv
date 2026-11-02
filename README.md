# dsh-arxiv · arXiv 速读

> DeepSeek Harness 的单篇 arXiv 快速阅读插件：**粘一个 arXiv ID，几秒出中文速览；左侧 AI 速览/问答，右侧原文，可并排可单看**。
> AI 用当前 DSH 会话的模型，并可在插件里随时切换（与输入框里的模型是同一份选择）。

- GitHub：<https://github.com/LyuYuxin/dsh-arxiv>

## 功能

- **只要一个 ID**：`2401.12345`、`arXiv:2401.12345v2`、`arxiv.org/abs/…`、`pdf/…pdf` 都能直接粘。
- **原文 + AI 内容一起看**：导入后分两栏——AI 栏是自动流式生成的中文速览（一句话总结 / 核心贡献 / 方法 / 实验与结果 / 局限性 / 谁该读）和追问对话；原文栏是从 arXiv/ar5iv 提取的论文正文，两栏各自滚动。顶部可切换 **并排 / 只看 AI / 只看原文**，正文可一键复制。
- **对这篇论文追问**：基于全文回答，支持多轮；回答会标注章节，找不到就直说。
- **自由切换当前 DSH 模型**：右上角模型选择器切换的就是当前会话模型；速览、问答随之使用新模型。
- **快**：摘要页元信息（快路径）与 ar5iv 全文并行获取；抓不到全文时先给「仅摘要」速览、全文到了提示一键重写；摘要请求自动用模型的最低 reasoning effort；全部流式输出。全文与速览都有缓存，同一篇重开是秒开。
- **极简**：不注入对话、不建后台任务、不装依赖；只有一个视图标签页和 4 个本地 Host 路由。

## 安装（另一台电脑）

前提：那台机器已安装并登录 DeepSeek Harness（桌面端至少启动过一次，profile 已初始化），并且能访问 GitHub。

```powershell
# 1) 克隆仓库
git clone https://github.com/LyuYuxin/dsh-arxiv.git
cd dsh-arxiv

# 2) 装进桌面端 profile（脚本会调用桌面端自带的 dsh CLI，并自动启用 bundle）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 3) 重启 DeepSeek Harness（profile 只在启动时组合）
```

重启后打开任一会话，顶部标签栏会出现 **arXiv 速读**（和 Chat / Trajectory 并列）。
当前会话还一条消息都没有时 DSH 会隐藏标签栏，用已有会话或先发一条消息即可。

想装到别的 profile（例如从终端跑 `dsh web`）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName web
```

`install.ps1` 用 `file:` 把源码目录装进 profile，并自动启用 bundle；改动源码后需要重跑并重启应用。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-arxiv
# 再从 %USERPROFILE%\.dsh\profiles\desktop\package.json 的 dsh.profile.bundles 里删掉 "dsh-arxiv"，重启
```

## 使用

1. 打开任一会话 → 顶部标签 **arXiv 速读**。
2. 粘贴 arXiv ID，回车（或点「导入」）。
3. 标题/作者/摘要先出现；AI 速览自动开始流式生成，原文栏同时加载正文。
4. 顶部「并排 / 只看 AI / 只看原文」切换布局；原文栏可「复制原文」。
5. 底部输入框追问，Enter 发送、Shift+Enter 换行；回答流式生成，可随时停止。
6. 右上角模型选择器切换当前会话模型；切换后可用「重新生成」让速览用新模型。
7. 「最近」保留最近 8 篇；同一篇 + 同一模型的速览会缓存，重开秒出；全文晚到时会提示「用全文重写」。
8. 论文很长时原文栏只渲染前 15 万字，其余请点 abs/PDF/HTML 链接。

## 实现

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半侧：`/dsh-arxiv/health`、`/meta`、`/text`（`body=1` 返回正文）、`/ai`（SSE）；元信息/全文缓存；通过 `ctx.llm.stream()` 调模型 |
| `client.js` | 浏览器半侧：手写 lazy-CJS bundle，注册 `conversation.view` 标签页（导入、原文/AI 双栏、速览、问答、模型选择器） |
| `src/arxiv.mjs` | arXiv ID 解析、元信息、全文抓取与 HTML→纯文本（ar5iv 优先；arXiv HTML / 仅摘要降级） |
| `src/prompt.mjs` | 速览/问答 prompt、文本预算与长度上限 |
| `cordis.patch.yml` | 插件在 profile 中的 Loader 行 |
| `test/` | 离线单测：ID 解析、HTML 提取、prompt、4 条 Host 路由 + SSE（`npm test`） |
| `tools/` | 隔离 `dsh web` 实例 + HTTP/DOM 端到端验证（开发用） |

请求链路（浏览器 → Host → 模型）：

```text
导入:  GET /dsh-arxiv/meta?id=...          摘要页解析（失败回退 export.arxiv.org API）
       GET /dsh-arxiv/text?id=...&body=1   ar5iv → arXiv HTML → 摘要；正文回传浏览器显示，同时进程内缓存
速览:  POST /dsh-arxiv/ai {mode:'summary', quality:'deep'|'fast', reasoningEffort:'low'}
问答:  POST /dsh-arxiv/ai {mode:'qa', question, history}
       → Host 组装 prompt（固定前缀利于 provider 前缀缓存）→ ctx.llm.stream()
       → SSE: start / reasoning? / delta… / done / error
模型:  client ctx.modelDirectories.directoryFor(sessionId).select(...)
       （与 DSH 输入框模型选择器是同一份选择）
```

## 开发与验证

```powershell
npm test                       # 等价于 node test/run.mjs，离线单测
node tools/install-dev.mjs     # 建隔离 DSH_HOME（%TEMP%\dsh-arxiv-dev）并安装插件
node tools/boot.mjs            # 起隔离 dsh web，打印 http://127.0.0.1:<port>/
node tools/e2e.mjs --http-only # 无浏览器：Host/SSE + boot manifest 校验
node tools/client-dom.mjs      # happy-dom + React 挂载真实 client.js，驱动导入/速览/问答/模型切换/原文栏
node tools/e2e.mjs             # 完整 Playwright（需普通终端，DSH 沙箱内无法启动 Chromium）
```

更多说明见 [tools/README.md](tools/README.md)。

## 数据与隐私

- 论文元信息与全文直接从 arXiv（`arxiv.org` / `ar5iv.labs.arxiv.org`）获取，不经过第三方服务。
- 生成速览/问答时，论文文本会随请求发给你在 DSH 里选择的模型提供方（与正常对话一致）。
- 插件只在浏览器 `localStorage` 存最近论文 ID/标题和速览缓存（按论文 + 模型），不上传。

## 已知限制

- 只做**单篇**快速阅读：没有检索、推荐、列表、引用图谱，也不做整篇翻译。
- 原文是自动提取的纯文本：公式/图表/排版请以 arXiv HTML 或 PDF 为准；论文超长时只渲染前 15 万字。
- ar5iv 未收录或抓取失败的论文会降级为「仅摘要」，速览质量下降，原文栏只显示摘要。
- 需要当前 DSH 至少有一个可用模型；没有模型时问答/速览会给出明确错误。
- 依赖 DSH 0.2.1-rc 系列（`conversation.view`、`modelDirectories` 等公开客户端约定）。

## License

MIT © Lyu Yuxin
