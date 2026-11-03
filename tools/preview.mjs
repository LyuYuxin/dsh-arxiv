#!/usr/bin/env node
// Chromium preview harness for the dsh-arxiv v0.3 sidebar panel (tools-only).
//
//   node tools/preview.mjs [--port 7811]
//
// Why this exists: this agent's DSH sandbox cannot start Chromium (Playwright's
// CDP pipe spawn fails with EPERM, raw Chrome dies on Mojo pipes). The DSH browser
// tool's Chrome runs outside the sandbox but only allows read-only opens and
// screenshots here, so this tool serves the REAL client.js from a tiny local HTTP
// server plus React 18 UMD and a same-origin proxy to the running dev host. A real
// Chromium can then open http://127.0.0.1:<port>/?state=... and render the actual
// panel with the actual host routes (meta/text/doc/ai SSE/attach), while fake DSH
// services supply a session list and model catalog. It is a rendering harness, not
// the app shell: the left sidebar/theme tokens are mocked.
//
// States: empty | import | summary | qa | splitter
// The page publishes a `READY <state> inner=... scrollW=... doc=...` status line
// used by tools/e2e or the agent's browser tool to wait before screenshots.
//
// Exit codes: 1 = cannot reach the dev host, 2 = bad args.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const artifactsDir = path.join(pluginRoot, 'test-artifacts')
const DSH_SRC = 'C:\\Users\\10174\\Documents\\deepseek-harness\\default-workspace\\dsh-src\\deepseek-harness-dsh-v0.2.1-rc.5'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const PORT = Number(option('--port', process.env.AXV_PREVIEW_PORT ?? '7811'))
const HOST = '127.0.0.1'

const state = JSON.parse(readFileSync(path.join(artifactsDir, 'dev-instance.json'), 'utf8'))
const origin = state.origin

// Browser-session cookie for the dev host (token URL bootstrap, same as e2e).
async function bootstrapCookie() {
  const response = await fetch(state.url, { redirect: 'manual' })
  const setCookies = response.headers.getSetCookie?.() ?? []
  const cookie = setCookies.map((value) => value.split(';')[0]).filter(Boolean).join('; ')
  return cookie || state.cookie || ''
}

const cookie = await bootstrapCookie()
const health = await fetch(`${origin}/dsh-arxiv/health`, { headers: cookie ? { cookie } : {} })
  .then((response) => response.json())
  .catch(() => null)
if (health === null || health.ok !== true) {
  console.error(`cannot reach the dev host at ${origin}/dsh-arxiv/health (start tools/boot.mjs first)`)
  process.exit(1)
}

// Warm the host caches (arxiv.org can be slow/rate-limited from this network): the
// panel then never races a cold /doc fetch, which the client silently falls back on.
async function warmHost() {
  const headers = cookie ? { cookie } : {}
  for (let attempt = 1; attempt <= 8; attempt++) {
    const results = []
    const doc = await fetch(`${origin}/dsh-arxiv/doc?id=1706.03762`, { headers }).then((r) => r.json()).catch(() => null)
    const text = await fetch(`${origin}/dsh-arxiv/text?id=1706.03762&body=1`, { headers }).then((r) => r.json()).catch(() => null)
    const meta = await fetch(`${origin}/dsh-arxiv/meta?id=1706.03762`, { headers }).then((r) => r.json()).catch(() => null)
    results.push(`doc=${doc?.ok === true ? `${doc.blocks?.length ?? 0} blocks` : `ERR ${doc?.error?.code ?? '?'}`}`)
    results.push(`text=${text?.ok === true ? `${text.chars ?? 0} chars` : `ERR ${text?.error?.code ?? '?'}`}`)
    results.push(`meta=${meta?.ok === true ? 'ok' : `ERR ${meta?.error?.code ?? '?'}`}`)
    console.log(`warm attempt ${attempt}: ${results.join(', ')}`)
    if (doc?.ok === true && (doc.blocks?.length ?? 0) > 80 && text?.ok === true && meta?.ok === true) return true
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  console.error('WARN: host caches are still cold; screenshots may render the plain-text fallback')
  return false
}
await warmHost()

const reactFile = path.join(DSH_SRC, 'node_modules', 'react', 'umd', 'react.development.js')
const reactDomFile = path.join(DSH_SRC, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js')
const clientFile = path.join(pluginRoot, 'client.js')

// Light-theme DSH semantic tokens used by the panel CSS (the real shell supplies
// these from ui-theme; the harness mocks the ones client.js references).
const TOKENS = `
:root{
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-2:#f7f8fa;
  --dsw-alias-bg-layer-3:#eef0f4;
  --dsw-alias-border-l2:#e3e6ec;
  --dsw-alias-border-l3:#d5d9e1;
  --dsw-alias-border-l4:#b8bec9;
  --dsw-alias-brand-primary:#4d6bfe;
  --dsw-alias-button-primary-fill:#4d6bfe;
  --dsw-alias-interactive-bg-hover:rgba(77,107,254,.08);
  --dsw-alias-label-primary:#1b1f27;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-label-secondary:#5a6272;
  --dsw-alias-label-tertiary:#8b93a3;
  --dsw-alias-state-error-primary:#d93838;
  --dsw-elevation-prominent:0 8px 28px rgba(0,0,0,.18);
  --dsw-focus-ring-color:#4d6bfe;
  --dsw-focus-ring-width:2px;
  --ds-transition-duration:.2s;
  --ds-ease-in-out:ease-in-out;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
#frame{display:flex;height:100%}
#mock-sidebar{width:232px;flex:none;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);padding:14px 10px;display:flex;flex-direction:column;gap:6px}
.mock-brand{display:flex;align-items:center;gap:8px;padding:4px 8px 14px;font-weight:650}
.mock-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:13px}
.mock-row.active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary);font-weight:600}
.mock-spacer{flex:1}
#panel-host{flex:1;min-width:0;height:100%}
#status{position:fixed;left:8px;bottom:6px;font:11px/1.3 Consolas,monospace;color:var(--dsw-alias-label-tertiary);background:rgba(255,255,255,.85);padding:2px 6px;border-radius:4px;pointer-events:none}
`

const HARNESS = String.raw`
(function () {
  'use strict'
  const state = new URLSearchParams(location.search).get('state') || 'empty'
  const fakeSessions = {
    ids: ['sess-alpha', 'sess-beta'],
    byId: {
      'sess-alpha': { id: 'sess-alpha', displayTitle: '验证会话 Alpha', origin: 'root', updatedAt: 2 },
      'sess-beta': { id: 'sess-beta', displayTitle: '验证会话 Beta', origin: 'root', updatedAt: 1 },
    },
  }
  const useSessions = (selector) => selector(fakeSessions)
  let modelCurrent = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }
  const groups = [{
    id: 'deepseek-account',
    name: 'DeepSeek Account',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } },
    ],
  }]
  const directories = {
    directoryFor() {
      return {
        load: async () => ({ current: modelCurrent, groups, status: { kind: 'ready' } }),
        select: async (selection) => {
          modelCurrent = { ...selection, reasoningEffort: selection.reasoningEffort ?? 'low' }
          return { ok: true }
        },
      }
    },
  }
  const sessions = {
    async using(id, options, callback) {
      await callback({ binding: { session: { async prompt(parts) { window.__axvPrompt = parts } } } })
      return { ok: true }
    },
  }
  const layout = { selectPanel(panelId) { window.__axvLayout = panelId } }
  const dictionaries = {}
  const locale = {
    register(namespace, language, dictionary) {
      dictionaries[language] = dictionary
      return () => {}
    },
    bind(namespace) {
      return (key, vars) => {
        const value = key.split('.').reduce((node, part) => (node === undefined ? undefined : node[part]), dictionaries.zh ?? dictionaries.en ?? {})
        if (typeof value !== 'string') return key
        if (vars === undefined) return value
        return value.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])))
      }
    },
  }
  const registrations = {}
  const ctx = {
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    locale,
    get(name) {
      if (name === 'modelDirectories') return directories
      if (name === 'sessions') return sessions
      if (name === 'layout') return layout
      return undefined
    },
    slots: {
      inject(name, callback) { callback() },
      register(spec, component) { registrations[spec.name] = { spec, component }; return () => {} },
    },
  }
  const definition = window.__axvDef
  if (definition === undefined) { document.getElementById('status').textContent = 'ERROR no __axvDef'; return }
  // The panel auto-restores the last paper on mount; clear it so the harness owns
  // the state (a restore racing our drive would leave the doc fetch stale, and the
  // empty state must stay empty).
  try { localStorage.removeItem('dsh-arxiv.lastPaper') } catch (error) { /* storage may be off */ }
  const mod = definition.factory((name) => {
    if (name === 'react') return window.React
    throw new Error('unexpected require(' + name + ')')
  })
  mod.apply(ctx)
  const root = ReactDOM.createRoot(document.getElementById('panel-host'))
  root.render(React.createElement(registrations.main.component, { useSessions }))

  const q = (selector) => document.querySelector(selector)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // Instrument the panel's own fetch calls so /doc /text /ai progress shows up in
  // the title while a state is being driven.
  //
  // The /meta response is delayed by 250ms on purpose: client.js clears
  // importRef.current in importPaper's finally, and docPromise's stale guard
  // compares against it, so a /doc that settles after /meta is silently dropped
  // (the paper pane then stays on the loading placeholder). Resolving /doc first
  // keeps the preview deterministic until that client race is fixed.
  const fetchLog = []
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = String(input)
    try {
      const response = await nativeFetch(input, init)
      fetchLog.push(url.replace(/^https?:\/\/[^/]+/, '') + '=' + response.status)
      if (url.includes('/dsh-arxiv/meta')) await sleep(250)
      return response
    } catch (error) {
      fetchLog.push(url.replace(/^https?:\/\/[^/]+/, '') + '=ERR')
      throw error
    }
  }
  const progress = () => 'doc=' + (q('[data-axv="doc"]') ? 1 : 0)
    + ' loading=' + document.querySelectorAll('.axv-doc-loading').length
    + ' fetches=' + fetchLog.slice(-6).join(',')
  setInterval(() => {
    if (document.title.startsWith('LOADING') || document.title.startsWith('STEP')) {
      document.title = 'STEP ' + state + ' ' + progress()
    }
  }, 500)
  async function waitFor(label, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { const value = predicate(); if (value) return value } catch (error) { /* retry */ }
      await sleep(120)
    }
    throw new Error('timeout waiting for ' + label)
  }
  function setInput(selector, value) {
    const element = q(selector)
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }
  function click(selector) {
    q(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  function metrics() {
    const inner = innerWidth + 'x' + innerHeight
    const scrollWidth = document.documentElement.scrollWidth
    return 'inner=' + inner + ' scrollW=' + scrollWidth + ' overflow=' + (scrollWidth > innerWidth + 1)
  }
  async function drive() {
    document.title = 'LOADING ' + state
    try {
      await waitFor('panel', () => q('[data-axv="panel"]'), 20000)
      if (state !== 'empty') {
        setInput('[data-axv="query"]', '1706.03762')
        await sleep(120)
        click('[data-axv="import"]')
        await waitFor('title', () => ((q('[data-axv="title"]') || {}).textContent || '').includes('Attention'), 60000)
        await waitFor('doc', () => q('[data-axv="doc"]'), 90000)
        if (state === 'summary' || state === 'qa' || state === 'splitter') {
          await waitFor('summary', () => /[\u4e00-\u9fff]/.test((q('[data-axv="summary"]') || {}).textContent || ''), 150000)
          await sleep(2000)
        }
        if (state === 'qa') {
          click('[data-axv="continue-qa"]')
          await sleep(300)
          setInput('[data-axv="ask-input"]', '这篇论文的主要贡献是什么？')
          await sleep(120)
          click('[data-axv="ask"]')
          await waitFor('answer', () => [...document.querySelectorAll('[data-axv="answer"]')].some((node) => (node.textContent || '').trim().length > 10), 180000)
          await sleep(1200)
        }
        if (state === 'splitter') {
          const panes = q('[data-axv="workspace"]')
          const box = panes.getBoundingClientRect()
          const splitter = q('[data-axv="splitter"]')
          const splitBox = splitter.getBoundingClientRect()
          const y = splitBox.top + splitBox.height / 2
          const startX = box.left + box.width / 2
          const endX = box.left + box.width * 0.7
          splitter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: startX, clientY: y }))
          document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: endX, clientY: y }))
          document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: endX, clientY: y }))
          await sleep(400)
        }
      }
      const counts = {
        heading: document.querySelectorAll('[data-axv="doc-heading"]').length,
        paragraph: document.querySelectorAll('[data-axv="doc-paragraph"]').length,
        table: document.querySelectorAll('[data-axv="doc-table"]').length,
        figure: document.querySelectorAll('[data-axv="doc-figure"]').length,
        equation: document.querySelectorAll('[data-axv="doc-equation"]').length,
        toc: document.querySelectorAll('[data-axv="toc"]').length,
      }
      const basis = ((q('[data-axv="ai-pane"]') || {}).style || {}).flexBasis || ''
      const summaryChars = ((q('[data-axv="summary"]') || {}).textContent || '').length
      const answers = document.querySelectorAll('[data-axv="answer"]').length
      const status = 'READY ' + state + ' ' + metrics()
        + ' doc=' + JSON.stringify(counts) + ' summaryChars=' + summaryChars + ' answers=' + answers + ' basis=' + basis
      document.getElementById('status').textContent = status
      document.title = status
    } catch (error) {
      const failure = 'ERROR ' + state + ' ' + (error && error.message ? error.message : String(error)) + ' ' + metrics()
      document.getElementById('status').textContent = failure
      document.title = failure
    }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(drive, 50)
  else window.addEventListener('load', () => setTimeout(drive, 50))
})()
`

function htmlPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-arxiv preview</title>
<style>${TOKENS}</style>
</head>
<body>
<div id="frame">
  <aside id="mock-sidebar">
    <div class="mock-brand">DeepSeek Harness</div>
    <div class="mock-row">新会话</div>
    <div class="mock-row">插件</div>
    <div class="mock-row">自动化任务</div>
    <div class="mock-row active">arXiv</div>
    <div class="mock-row">更多</div>
    <div class="mock-spacer"></div>
    <div class="mock-row">工作区</div>
  </aside>
  <main id="panel-host"></main>
</div>
<div id="status">BOOT</div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
  window.__ModuleLoader__ = { load: function (definition) { window.__axvDef = definition } }
</script>
<script src="/client.js"></script>
<script src="/harness.js"></script>
</body>
</html>`
}

const SPA_FILES = {
  '/': () => ({ type: 'text/html; charset=utf-8', body: htmlPage() }),
  '/react.js': () => ({ type: 'text/javascript; charset=utf-8', body: readFileSync(reactFile, 'utf8') }),
  '/react-dom.js': () => ({ type: 'text/javascript; charset=utf-8', body: readFileSync(reactDomFile, 'utf8') }),
  '/client.js': () => ({ type: 'text/javascript; charset=utf-8', body: readFileSync(clientFile, 'utf8') }),
  '/harness.js': () => ({ type: 'text/javascript; charset=utf-8', body: HARNESS }),
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function proxy(request, response, pathname) {
  const startedAt = Date.now()
  console.log(`proxy ${request.method} ${pathname.slice(0, 80)}`)
  const headers = { ...(cookie ? { cookie } : {}) }
  let body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await readBody(request)
    headers['content-type'] = request.headers['content-type'] ?? 'application/json'
  }
  const upstream = await fetch(`${origin}${pathname}`, { method: request.method, headers, body, redirect: 'manual' })
  response.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  if (upstream.body === null) { response.end(); return }
  const reader = upstream.body.getReader()
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    response.write(Buffer.from(value))
  }
  response.end()
  console.log(`proxy done ${request.method} ${pathname.slice(0, 60)} -> ${upstream.status} ${bytes}B ${Date.now() - startedAt}ms`)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
    const spa = SPA_FILES[url.pathname]
    if (spa !== undefined) {
      const file = spa()
      response.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' })
      response.end(file.body)
      return
    }
    if (url.pathname.startsWith('/dsh-arxiv/')) {
      await proxy(request, response, `${url.pathname}${url.search}`)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(String(error?.message ?? error))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`dsh-arxiv preview harness: http://${HOST}:${PORT}/?state=empty`)
  console.log(`host proxy -> ${origin}  (state: empty | import | summary | qa | splitter)`)
})
