# dsh-arxiv verification tools

Isolated dev-instance harness for the `dsh-arxiv` DSH plugin. The tools never touch
the running desktop app or `%USERPROFILE%\.dsh`; everything lives in
`%TEMP%\dsh-arxiv-dev` and a dedicated CLI `web` profile.

| Tool | What it does |
|---|---|
| `tools/install-dev.mjs` | fresh `DSH_HOME`, copies credentials, installs `dsh-arxiv` into profile `web`, patches the default model, optionally junction-links the source |
| `tools/boot.mjs` | spawns `dsh web --no-open --port <free>` with that `DSH_HOME`, waits for the printed URL, resolves the browser-session cookie, stays alive as the managed parent |
| `tools/e2e.mjs` | full verification: boot manifest + client bundle + `/dsh-arxiv/health`, `/meta`, `/text`, real `/ai` summary + QA SSE, then Playwright Chrome for the UI |
| `tools/client-dom.mjs` | browser-half proof without Chromium: mounts the real `client.js` in happy-dom + React, drives the live host routes, asserts every `data-axv` hook |

## Prerequisites

- Node.js on `PATH` (v20+; the bundled Electron runtime also works via `dsh.cmd`).
- The DSH install at `D:\DeepseekHarness` (CLI: `D:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd`).
- A signed-in desktop DSH so `%USERPROFILE%\.dsh\.credentials.yaml` exists.
- Chromium only for the full `e2e.mjs` run: Chrome must be installed; Playwright is
  used from `dsh-src\deepseek-harness-dsh-v0.2.1-rc.5\node_modules\playwright`.

## 1. Install the dev instance

```powershell
cd C:\Users\10174\Documents\deepseek-harness\default-workspace\dsh-arxiv
node tools\install-dev.mjs            # fresh dev home + plugin install (file: dependency)
node tools\install-dev.mjs --keep     # reuse the dev home, reinstall the plugin
node tools\install-dev.mjs --link     # + junction node_modules\dsh-arxiv -> plugin source
                                      #   (live edits; restart boot to reload the host half)
```

What it sets up:

- `%TEMP%\dsh-arxiv-dev\` — isolated `DSH_HOME` (fresh unless `--keep`).
- `.credentials.yaml`, `llm-deepseek\`, `.anonymous-user-id` copied from the real
  `~/.dsh` (read-only here), so the real DeepSeek account models route.
- `%TEMP%\dsh-arxiv-dev\profiles\web\` — the CLI `web` profile; `dsh-arxiv` is in
  `dependencies` and appended to `dsh.profile.bundles` after
  `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`.
- `profiles\web\cordis.patch.yml` — `agent-default-model` override to
  `provider: deepseek-account`, `model: deepseek-flash` (a fresh profile defaults to
  `deepseek-official`, which needs `DEEPSEEK_API_KEY`).

Both `file:` installs and `--link` reuse the freshly written plugin files; boot once
after changing `index.js` (the host half is composed at boot), no restart is needed
for `client.js` edits because the browser fetches it per load.

## 2. Boot the dev web instance

```powershell
node tools\boot.mjs                    # free port, 30 min timeout
node tools\boot.mjs --port 5123        # fixed port
node tools\boot.mjs --timeout 0        # never time out
```

It prints the token URL, PID and state file, e.g.

```
URL  http://127.0.0.1:60873/?token=...
PID  4784
DSH_HOME  C:\Users\10174\AppData\Local\Temp\dsh-SPlRcp\dsh-arxiv-dev
state     ...\dsh-arxiv\test-artifacts\dev-instance.json
```

Open that URL in any browser to look at the GUI by hand; a plain GET without the
token answers 401, the token URL sets the `client-connection/browser-session`
cookie. `Ctrl+C` stops the child (`taskkill /t`), so no Electron processes linger.

The instance state is recorded in `test-artifacts\dev-instance.json`
(`url`, `origin`, `cookie`, `pid`, `dshHome`); `e2e.mjs` and `client-dom.mjs`
read it, so keep the boot process running.

## 3. Verify

```powershell
# inside the DSH sandbox (no Chromium available):
node tools\e2e.mjs --http-only
node tools\client-dom.mjs

# from a normal PowerShell outside the sandbox (full browser UI + screenshots):
node tools\e2e.mjs
node tools\e2e.mjs --headed --keep-open     # visible browser, left open to inspect
```

`--http-only` asserts (27 checks):

- `GET /` 200; `__DSH_BOOT__` parses; the `dsh-arxiv` client entry exists and
  `plugins/??dsh-arxiv/client.js&rev=...` returns 200 JS containing
  `__ModuleLoader__` and `[data-axv=root]`.
- `GET /dsh-arxiv/health` → `{ok:true,name:"dsh-arxiv",version:"0.1.0"}`.
- `GET /dsh-arxiv/meta?id=1706.03762` → `ok:true`, full title/authors/abstract.
- `GET /dsh-arxiv/text?id=1706.03762` → `ok:true`, `source:"ar5iv"`, >1000 chars,
  and **no `text` field** (AI calls never ship the paper body).
- `GET /dsh-arxiv/text?id=1706.03762&body=1` → the in-app 原文 pane opt-in: `text`
  is a string >20,000 chars, `chars` matches its length, it contains the paper
  title, and `source` is `ar5iv`/`arxiv-html`.
- `POST /dsh-arxiv/ai` (`mode:"summary"`, real `deepseek-account` model,
  `reasoningEffort:"low"`) streams `start` → `delta` (Chinese, contains
  `## 一句话总结`) → `done` with usage; then a `mode:"qa"` round for
  "这篇论文的主要贡献是什么？".

`client-dom.mjs` additionally mounts the real client bundle in happy-dom + React 18
(the DOM library DSH's own client tests can use; this machine's Node 21 cannot load
jsdom 29's ESM dependency graph). It asserts `[data-axv=root|query|import|model]`
render, the model picker opens two `[data-axv=model-option]` rows and switches
provider/model through a fake `modelDirectories` service, the `query` input enables
`import`, `[data-axv=status]` shows while importing, `[data-axv=title]` becomes the
full paper title, Chinese streams into `[data-axv=summary]` (including the
`一句话总结` / `核心贡献` sections once markdown renders) and the streamed answer lands
in `[data-axv=answer]`; it also asserts the summary request used the selected
provider + lowest reasoning effort and the QA request kept the session effort.

It also covers the original-text reading pane: `[data-axv=source]` renders,
`[data-axv=source-text]` contains the paper title, ≥50 paragraph/heading blocks and
>20,000 rendered chars, `[data-axv=source-copy]` exists, and the segmented control
`[data-axv=mode-split|mode-ai|mode-source]` starts with split `data-active="true"`
and toggles both `data-active` and the `.axv-workspace` class
(`axv-mode-split`/`ai`/`source`). A clean run also asserts there were **no React
warnings/errors** in the console capture. Artifacts: `test-artifacts/dom-snapshot.html`,
`dom-summary.txt`, `dom-qa.txt`, `dom-source-text.txt`, `dom-report.json`.

The full browser run drives the same assertions through the real app shell: opens
the `arXiv 速读` view tab, imports the paper, waits for the streamed summary and a
QA answer, checks the original-text pane and mode switch, opens the model picker,
and saves full-page screenshots `test-artifacts/e2e-*.png`, plus `e2e-report.json`,
`boot-manifest.json`, `meta.json`, `summary.txt`, `qa.txt`, `source-text.txt`.

## Debugging

- Headed browser: `node tools\e2e.mjs --headed --keep-open` (Chrome visible,
  DevTools via F12; the script exits without closing the window).
- Attach to an already running debug browser: launch Chrome with
  `--remote-debugging-port=9222 --user-data-dir=%TEMP%\axv-debug`, then
  `node tools\e2e.mjs --cdp http://127.0.0.1:9222`.
- Other paper: `node tools\e2e.mjs --http-only --paper 2004.00026`.
- Longer streams: `--timeout 300000`.
- A boot that prints no URL: read `test-artifacts\dev-instance.err.log`; a fresh
  dev home bootstraps the profile on first use, which can take a few seconds.
- The token URL rotates on every boot; always restart through `boot.mjs` instead of
  reusing a stale URL.

## Chromium inside the DSH sandbox (known boundary)

Every command in this session runs under `dsh-sandbox-windows-acl`: a restricted
token lowered to Low integrity inside a kill-on-close job object. Chromium-based
browsers (Chrome 156, Edge) cannot create the Mojo named pipes / child processes
they need and die with
`FATAL:mojo/public/cpp/platform/platform_channel.cc Check failed: Access denied (0x5)`;
Playwright's own launch additionally fails at `spawn EPERM` because it uses a
`--remote-debugging-pipe`. `node tools\e2e.mjs` therefore exits 3 inside the
sandbox with that explanation, while `--http-only` and `client-dom.mjs` cover the
host routes, SSE, and the client DOM. The one command a user can run outside the
sandbox for the visual pass is:

```powershell
node C:\Users\10174\Documents\deepseek-harness\default-workspace\dsh-arxiv\tools\e2e.mjs
```

Firefox is not a fallback: Playwright's Firefox transport is also a pipe, and the
browser downloader itself spawns a piped child (`spawn EPERM`).
