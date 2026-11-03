#!/usr/bin/env node
// Browser-half proof without a browser: mount the real dsh-arxiv client bundle in
// a DOM (happy-dom) + React 18, drive the live host routes (meta/text/doc/ai SSE)
// through a fetch shim, and assert the stable `data-axv` hooks end to end.
//
//   node tools/client-dom.mjs [--paper 1706.03762]
//
// v0.3 shape: a left-sidebar global panel (`sidebar.panellist` id=arxiv + keyed
// `main` slot key=arxiv) with a two-row topbar (brand/title/session/model/attach/
// send/library-toggle, then query/import/layout tabs), a meta row, and a
// split AI pane | splitter | typeset paper pane (doc/text modes, TOC).
// `/dsh-arxiv/attach` is answered by a fake store so attach/detach is
// deterministic while meta/text/doc/ai still hit the live dev host.
//
// Why not a real browser here: this agent's DSH sandbox cannot start Chromium
// (spawn EPERM for Playwright's CDP pipe; raw Chrome dies on Mojo pipes). The
// interactive UI pass is tools/e2e.mjs, run from an unrestricted shell.
//
// Exit codes: 0 pass, 1 assertion failure, 2 usage.

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const artifactsDir = path.join(pluginRoot, 'test-artifacts')
const DSH_SRC = 'C:\\Users\\10174\\Documents\\deepseek-harness\\default-workspace\\dsh-src\\deepseek-harness-dsh-v0.2.1-rc.5'
const require = createRequire(path.join(DSH_SRC, 'package.json'))

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const paperId = option('--paper', '1706.03762')

const state = JSON.parse(readFileSync(path.join(artifactsDir, 'dev-instance.json'), 'utf8'))
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/
const checks = []
function assert(condition, name, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!condition) {
    throw new Error(`${name}: ${detail}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 120000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true
    } catch {
      // not ready yet
    }
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`)
}

// ── auth (same token bootstrap as tools/e2e.mjs) ─────────────────────────────
async function resolveCookie() {
  const response = await fetch(state.url, { redirect: 'manual' })
  const setCookies = response.headers.getSetCookie?.() ?? []
  const cookie = setCookies.map((value) => value.split(';')[0]).filter(Boolean).join('; ')
  return cookie || state.cookie || ''
}

const cookie = await resolveCookie()
const origin = state.origin

// Warm the host meta/text/doc caches first. arxiv.org is slow/rate-limited from
// this network and the client silently falls back to plain text when /doc fails,
// so the panel import below must never race a cold host fetch.
async function warmHost() {
  const headers = cookie ? { cookie } : {}
  for (let attempt = 1; attempt <= 8; attempt++) {
    const meta = await fetch(`${origin}/dsh-arxiv/meta?id=1706.03762`, { headers }).then((r) => r.json()).catch(() => null)
    const text = await fetch(`${origin}/dsh-arxiv/text?id=1706.03762&body=1`, { headers }).then((r) => r.json()).catch(() => null)
    const doc = await fetch(`${origin}/dsh-arxiv/doc?id=1706.03762`, { headers }).then((r) => r.json()).catch(() => null)
    const summary = `meta=${meta?.ok === true ? 'ok' : meta?.error?.code ?? '?'}, text=${text?.ok === true ? `${text.chars ?? 0} chars` : text?.error?.code ?? '?'}, doc=${doc?.ok === true ? `${doc.blocks?.length ?? 0} blocks` : doc?.error?.code ?? '?'}`
    console.log(`warming host (attempt ${attempt}): ${summary}`)
    if (meta?.ok === true && text?.ok === true && doc?.ok === true && (doc.blocks?.length ?? 0) > 80) return
    await sleep(5000)
  }
  console.warn('WARN: host caches still cold; the doc assertions may fail on a cold /doc')
}
await warmHost()

// ── DOM environment ─────────────────────────────────────────────────────────
// happy-dom (not jsdom) because jsdom 29 needs Node >=22.13's require(ESM);
// this machine's node is 21.7. The window must exist BEFORE react-dom is
// required: react-dom captures `canUseDOM`/window at module init and silently
// drops onChange delegation otherwise (clicks still work, text inputs do not).
const { Window } = await import(pathToFileURL(path.join(DSH_SRC, 'node_modules', 'happy-dom', 'lib', 'index.js')).href)
const win = new Window({ url: `${origin}/` })
const document = win.document
document.body.innerHTML = '<div id="app"></div>'
globalThis.window = win
globalThis.document = document
globalThis.localStorage = win.localStorage
try {
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
} catch {
  // Node keeps its own navigator; client only touches navigator.clipboard on copy.
}
globalThis.requestAnimationFrame = (callback) => win.requestAnimationFrame(callback)
globalThis.cancelAnimationFrame = (handle) => win.cancelAnimationFrame(handle)

const React = require('react')
const ReactDOM = require('react-dom/client')

// Seed the library so the panel renders its library chips and pin toggles.
win.localStorage.setItem('dsh-arxiv.library', JSON.stringify([
  { id: '1706.03762', title: 'Attention Is All You Need', pinned: false, updatedAt: 1 },
  { id: '2005.14165', title: 'Language Models are Few-Shot Learners', pinned: true, updatedAt: 2 },
]))

// ── fake services / slot registrations ─────────────────────────────────────
const modelState = {
  // A normal DSH session carries the selected reasoning effort; summaries ask for
  // the model's lowest effort so hidden thinking cannot eat the output budget.
  current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
  selectCalls: [],
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } },
      ],
    },
  ],
}
const modelDirectories = {
  directoryFor(sessionId) {
    return {
      load: async () => ({ current: modelState.current, groups: modelState.groups, status: { kind: 'ready' } }),
      select: async (selection) => {
        // The real directory keeps the session's effort unless the model changes.
        const chosen = { ...selection, reasoningEffort: selection.reasoningEffort ?? 'low' }
        modelState.selectCalls.push(chosen)
        modelState.current = chosen
        return { ok: true }
      },
    }
  },
}

// Two root sessions for the target-session picker.
const fakeSessionState = {
  ids: ['sess-alpha', 'sess-beta'],
  byId: {
    'sess-alpha': { id: 'sess-alpha', displayTitle: 'Alpha 论文会话', origin: 'root', updatedAt: 2 },
    'sess-beta': { id: 'sess-beta', displayTitle: 'Beta 论文会话', origin: 'root', updatedAt: 1 },
  },
}
const useSessions = (selector) => selector(fakeSessionState)

const promptCalls = []
const sessionsService = {
  async using(sessionId, options, callback) {
    const reference = {
      binding: {
        session: {
          async prompt(parts, mode) {
            promptCalls.push({ sessionId, options, parts, mode })
          },
        },
      },
    }
    await callback(reference)
    return { ok: true }
  },
}
const layoutCalls = []
const layoutService = { selectPanel: (panelId) => layoutCalls.push(panelId) }

const slotNames = []
const registrations = {}
const fakeCtx = {
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  get: (name) => {
    if (name === 'modelDirectories') return modelDirectories
    if (name === 'sessions') return sessionsService
    if (name === 'layout') return layoutService
    return undefined
  },
  slots: {
    inject(name, callback) {
      slotNames.push(name)
      callback()
    },
    register(spec, component) {
      registrations[spec.name] = { spec, component }
      return () => {}
    },
  },
}

// ── fetch shim: real host routes, fake /dsh-arxiv/attach store ─────────────
const nodeFetch = globalThis.fetch.bind(globalThis)
const aiRequests = []
const attachCalls = []
let fakeAttached = null
const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

globalThis.fetch = async (input, init = {}) => {
  const url = /^https?:/i.test(String(input)) ? String(input) : new URL(String(input), `${origin}/`).href
  const method = String(init.method ?? 'GET').toUpperCase()
  if (url.includes('/dsh-arxiv/attach')) {
    if (method === 'GET') {
      const sessionId = new URL(url).searchParams.get('sessionId')
      attachCalls.push({ method, sessionId })
      return jsonResponse({ ok: true, attached: fakeAttached })
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    attachCalls.push({ method, sessionId: body.sessionId, paperId: body.paperId ?? null })
    if (body.paperId === null || body.paperId === undefined) {
      fakeAttached = null
    } else {
      const baseId = String(body.paperId).replace(/v\d+$/, '')
      fakeAttached = {
        id: body.paperId,
        baseId,
        title: 'Attention Is All You Need',
        primaryCategory: 'cs.CL',
        published: '2017-06-12',
      }
    }
    return jsonResponse({ ok: true, attached: fakeAttached })
  }
  const headers = new Headers(init.headers ?? {})
  if (cookie) headers.set('cookie', cookie)
  if (url.endsWith('/dsh-arxiv/ai') && typeof init.body === 'string') {
    try {
      aiRequests.push(JSON.parse(init.body))
    } catch {
      // ignore malformed body (the client never sends one)
    }
  }
  return nodeFetch(url, { ...init, headers })
}

// ── load the real client bundle the way the platform does ──────────────────
const bundleSource = readFileSync(path.join(pluginRoot, 'client.js'), 'utf8')
const loaded = []
win.__ModuleLoader__ = { load: (definition) => loaded.push(definition) }
// eslint-disable-next-line no-new-func
new Function(bundleSource)()
assert(loaded.length === 1, 'client.js registers exactly one __ModuleLoader__ definition', `id=${loaded[0]?.id}`)
assert(loaded[0].id === 'dsh-arxiv', 'client module id is dsh-arxiv', loaded[0].id)
assert(typeof loaded[0].factory === 'function', 'client module exposes a factory')

const mod = loaded[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})
assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'client module injects slots', JSON.stringify(mod.inject))

// ── apply(): capture both slot registrations ───────────────────────────────
mod.apply(fakeCtx)
assert(slotNames.includes('sidebar.panellist'), 'apply() injects into the sidebar.panellist slot', slotNames.join(','))
assert(slotNames.includes('main'), 'apply() injects into the keyed main slot', slotNames.join(','))
const panellist = registrations['sidebar.panellist']
const mainPanel = registrations.main
assert(panellist !== undefined && mainPanel !== undefined, 'both slot registrations were captured')
assert(panellist.spec.id === 'arxiv', 'sidebar.panellist registration id is arxiv', JSON.stringify({ id: panellist.spec.id, order: panellist.spec.order }))
assert(typeof panellist.spec.label === 'function' && typeof panellist.spec.label() === 'string', 'panellist has a label function', String(panellist.spec.label?.()))
assert(mainPanel.spec.name === 'main' && mainPanel.spec.key === 'arxiv', 'main registration is keyed main/arxiv', JSON.stringify({ name: mainPanel.spec.name, key: mainPanel.spec.key }))
assert(typeof panellist.component === 'function' && typeof mainPanel.component === 'function', 'both registrations have components')
assert(win.document.querySelector('style[data-plugin="dsh-arxiv"]') !== null, 'apply() injects the axv style element')

// React dev-mode warnings go through console.error; capture them so the run can
// assert a clean render instead of only looking at PASS lines.
const consoleMessages = []
const originalConsoleError = console.error.bind(console)
const originalConsoleWarn = console.warn.bind(console)
console.error = (...parts) => {
  consoleMessages.push(['error', parts.map(String).join(' ')])
  originalConsoleError(...parts)
}
console.warn = (...parts) => {
  consoleMessages.push(['warn', parts.map(String).join(' ')])
  originalConsoleWarn(...parts)
}

// ── render the panel body (the `main` slot component) ──────────────────────
const root = ReactDOM.createRoot(win.document.getElementById('app'))
root.render(React.createElement(mainPanel.component, { useSessions }))
const text = (selector) => win.document.querySelector(selector)?.textContent ?? ''
const count = (selector) => win.document.querySelectorAll(selector).length
const attr = (selector, name) => win.document.querySelector(selector)?.getAttribute(name) ?? null
const setInput = (selector, value) => {
  const element = win.document.querySelector(selector)
  if (element === null) throw new Error(`missing ${selector}`)
  // React tracks the native value setter, so call the prototype setter of the
  // element's own class (query is <input>, ask-input is <textarea>).
  const prototype = element.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (typeof descriptor?.set === 'function') descriptor.set.call(element, value)
  else element.value = value
  element.dispatchEvent(new win.Event('input', { bubbles: true }))
  element.dispatchEvent(new win.Event('change', { bubbles: true }))
}
const click = (selector) => {
  const element = win.document.querySelector(selector)
  if (element === null) throw new Error(`missing ${selector}`)
  element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
}
const clickNode = (node) => node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
const pointer = (target, type, clientX) => target.dispatchEvent(new win.MouseEvent(type, {
  bubbles: true,
  cancelable: true,
  clientX,
  clientY: 200,
  button: 0,
}))

try {
  await waitFor('[data-axv=panel]', () => count('[data-axv="panel"]') === 1, 15000)
  assert(true, '[data-axv=panel] wrapper rendered')
  for (const selector of ['topbar', 'session', 'query', 'import', 'model', 'library-toggle']) {
    assert(count(`[data-axv="${selector}"]`) === 1, `[data-axv=${selector}] present`)
  }
  // The import row and meta row are rendered as `.axv-import-row` / `.axv-meta-row`
  // (the data-axv hooks from the v0.3 spec are not in client.js yet, so the test
  // anchors on the documented class names and reports the gap).
  assert(count('.axv-import-row') === 1, 'import row rendered (.axv-import-row)')
  assert(count('.axv-meta-row') === 1, 'meta row rendered (.axv-meta-row)')

  // Empty state: the centered hero with clickable example papers.
  assert(count('.axv-empty') === 1, 'empty hero renders inside [data-axv=panel]')
  assert(count('.axv-example') === 3, 'empty state shows three example paper buttons', `${count('.axv-example')} examples`)

  // Library chips seeded from localStorage (libraryOpen defaults to true).
  assert(count('[data-axv="library"]') === 1, '[data-axv=library] rendered')
  assert(count('[data-axv="library-item"]') === 2, '[data-axv=library-item] rows rendered', `${count('[data-axv="library-item"]')} items`)
  assert(count('[data-axv="pin"]') === 2, '[data-axv=pin] buttons rendered')
  const unpinnedItem = [...win.document.querySelectorAll('[data-axv="library-item"]')].find((node) => node.getAttribute('data-pinned') === 'false')
  clickNode(unpinnedItem.querySelector('[data-axv="pin"]'))
  await waitFor('pin toggle', () => {
    const stored = JSON.parse(win.localStorage.getItem('dsh-arxiv.library') ?? '[]')
    return stored.filter((item) => item.pinned === true).length === 2
  }, 10000)
  assert(true, 'pin click toggles the library star and persists')
  assert(JSON.parse(win.localStorage.getItem('dsh-arxiv.library') ?? '[]')[0].pinned === true, 'pinned papers sort first in the library')

  // Target session picker.
  await waitFor('target session label', () => text('[data-axv="session"]').includes('Alpha'), 15000)
  assert(text('[data-axv="session"]').includes('Alpha 论文会话'), 'session trigger shows the first target session', text('[data-axv="session"]'))
  click('[data-axv="session"]')
  await waitFor('session options', () => count('[data-axv="session-option"]') === 2, 10000)
  assert(count('[data-axv="session-option"]') === 2, 'session picker lists session-option rows', `${count('[data-axv="session-option"]')} sessions`)
  clickNode([...win.document.querySelectorAll('[data-axv="session-option"]')].find((node) => node.textContent.includes('Beta')))
  await waitFor('session switch', () => text('[data-axv="session"]').includes('Beta'), 10000)
  assert(true, 'session picker switches the target session', text('[data-axv="session"]'))
  assert(win.localStorage.getItem('dsh-arxiv.targetSession') === '"sess-beta"', 'target session persists to localStorage', String(win.localStorage.getItem('dsh-arxiv.targetSession')))

  // Model picker: the v0.3 trigger only shows the model name (not the provider).
  assert(text('[data-axv="model"]') === 'DeepSeek-V4.1-Flash', 'model trigger shows only the model name', text('[data-axv="model"]'))
  click('[data-axv="model"]')
  await waitFor('model options', () => count('[data-axv="model-option"]') === 2, 10000)
  assert(count('[data-axv="model-option"]') === 2, 'model picker lists model-option rows', `${count('[data-axv="model-option"]')} rows`)
  clickNode([...win.document.querySelectorAll('[data-axv="model-option"]')].find((node) => node.textContent.includes('V4-Pro')))
  await waitFor('model switch', () => text('[data-axv="model"]') === 'DeepSeek-V4-Pro', 15000)
  assert(modelState.selectCalls.length === 1, 'clicking a model row calls modelDirectories.select()', JSON.stringify(modelState.selectCalls[0]))
  assert(count('[data-axv="model-option"]') === 0, 'model picker closes after selecting')
  click('[data-axv="model"]')
  await waitFor('model options again', () => count('[data-axv="model-option"]') === 2, 10000)
  clickNode([...win.document.querySelectorAll('[data-axv="model-option"]')].find((node) => node.textContent.includes('V4.1-Flash')))
  await waitFor('model switch back', () => text('[data-axv="model"]') === 'DeepSeek-V4.1-Flash', 15000)
  assert(modelState.selectCalls.length === 2, 'a second model switch reaches the directory', JSON.stringify(modelState.selectCalls[1]))

  // import the paper: real /meta + /text?body=1 + /doc, then the /ai summary
  setInput('[data-axv="query"]', paperId)
  assert(win.document.querySelector('[data-axv="query"]')?.value === paperId, '[data-axv=query] accepts the arXiv id')
  assert(win.document.querySelector('[data-axv="import"]')?.disabled === false, '[data-axv=import] is enabled once the id is typed')
  click('[data-axv="import"]')
  await waitFor('[data-axv=status] during import', () => count('[data-axv="status"]') === 1, 15000)
  assert(true, '[data-axv=status] appears while importing', text('[data-axv="status"]'))
  await waitFor('[data-axv=title]', () => text('[data-axv="title"]').includes('Attention'), 60000)
  assert(true, '[data-axv=title] shows the imported paper in the topbar', text('[data-axv="title"]'))
  assert(text('[data-axv="title"]').length > 20, 'title is the full paper title', text('[data-axv="title"]'))

  // Body/layout: panes, default split mode, mode tabs, actions.
  for (const selector of ['body', 'workspace', 'ai-pane', 'paper-pane', 'splitter', 'attach', 'send-agent']) {
    assert(count(`[data-axv="${selector}"]`) === 1, `[data-axv=${selector}] present after import`)
  }
  for (const selector of ['mode-split', 'mode-ai', 'mode-source', 'ai-tab-summary', 'ai-tab-qa', 'continue-qa']) {
    assert(count(`[data-axv="${selector}"]`) === 1, `[data-axv=${selector}] present after import`)
  }
  assert(/axv-mode-split/.test(attr('[data-axv="workspace"]', 'class') ?? ''), 'workspace starts in axv-mode-split', attr('[data-axv="workspace"]', 'class'))
  assert(attr('[data-axv="mode-split"]', 'data-active') === 'true', 'split layout tab is active by default')
  assert(attr('[data-axv="ai-tab-summary"]', 'data-active') === 'true', 'summary AI tab is active by default')

  // Splitter: default 50/50 through the AI pane flex-basis, pointer drag, double-click.
  const aiPaneBasis = () => win.document.querySelector('[data-axv="ai-pane"]')?.style?.flexBasis ?? ''
  assert(aiPaneBasis() === '50%', 'split panes start 50/50 (flex-basis 50%)', aiPaneBasis())
  const workspaceEl = win.document.querySelector('[data-axv="workspace"]')
  workspaceEl.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, toJSON: () => ({}) })
  pointer(win.document.querySelector('[data-axv="splitter"]'), 'pointerdown', 500)
  pointer(document, 'pointermove', 700)
  await waitFor('splitter drag', () => aiPaneBasis() === '70%', 10000)
  assert(true, 'dragging the splitter changes the AI pane flex-basis', aiPaneBasis())
  pointer(document, 'pointerup', 700)
  assert(Math.abs(Number(win.localStorage.getItem('dsh-arxiv.split')) - 0.7) < 0.001, 'splitter ratio persists on pointerup', String(win.localStorage.getItem('dsh-arxiv.split')))
  win.document.querySelector('[data-axv="splitter"]').dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  await waitFor('splitter reset', () => aiPaneBasis() === '50%', 10000)
  assert(true, 'double-clicking the splitter restores 50/50', aiPaneBasis())

  // Structured paper document (real /doc): headings/paragraphs/tables/figures/equations + TOC.
  await waitFor('[data-axv=doc]', () => count('[data-axv="doc"]') === 1, 90000)
  const docCounts = {
    heading: count('[data-axv="doc-heading"]'),
    paragraph: count('[data-axv="doc-paragraph"]'),
    table: count('[data-axv="doc-table"]'),
    figure: count('[data-axv="doc-figure"]'),
    equation: count('[data-axv="doc-equation"]'),
    toc: count('[data-axv="toc"]'),
  }
  assert(docCounts.heading > 0, '[data-axv=doc] renders doc-heading blocks', `${docCounts.heading} headings`)
  assert(docCounts.paragraph > 20, '[data-axv=doc] renders doc-paragraph blocks', `${docCounts.paragraph} paragraphs`)
  assert(docCounts.table >= 1, '[data-axv=doc] renders doc-table blocks', `${docCounts.table} tables`)
  assert(docCounts.figure >= 1, '[data-axv=doc] renders doc-figure blocks', `${docCounts.figure} figures`)
  assert(docCounts.equation >= 1, '[data-axv=doc] renders doc-equation blocks', `${docCounts.equation} equations`)
  assert(docCounts.toc >= 1, '[data-axv=doc] renders the table of contents', `${docCounts.toc} toc`)
  assert(count('[data-axv="toc-toggle"]') === 1, '[data-axv=toc-toggle] present')
  assert(count('[data-axv="paper-mode-doc"]') === 1 && count('[data-axv="paper-mode-text"]') === 1, 'paper-mode tabs appear once the doc is ready')
  assert(attr('[data-axv="paper-mode-doc"]', 'data-active') === 'true', 'paper pane starts in structured doc mode')
  const docText = text('[data-axv="doc"]')
  const tocCount = win.document.querySelectorAll('[data-axv="toc"] button').length
  assert(tocCount >= 6 && tocCount <= 26, 'TOC lists top-level chapters (6..26 entries)', `${tocCount} entries`)
  const equationNode = win.document.querySelector('[data-axv="doc-equation"]')
  const equationText = equationNode?.textContent ?? ''
  const equationTitle = equationNode?.getAttribute('title') ?? ''
  assert(!/\\mathrm|\\frac|\\sqrt/.test(equationText), 'doc-equation renders readable math text', equationText.slice(0, 80))
  assert(/\\[a-zA-Z]+|_\{|\^\{/.test(equationTitle), 'doc-equation keeps the LaTeX in its title tooltip', equationTitle.slice(0, 80))
  assert(!docText.includes('Provided proper attribution'), 'doc filters the ar5iv attribution placeholder', docText.slice(0, 60))
  assert(count('[data-axv="source"]') === 1 && count('[data-axv="source-text"]') === 1, 'source scroll area and source-text present')
  assert(docText.includes('Attention Is All You Need'), 'doc text contains the paper title', docText.slice(0, 80).replace(/\n/g, ' '))
  assert(docText.length > 20000, 'doc renders the full paper text', `${docText.length} chars`)
  writeFileSync(path.join(artifactsDir, 'dom-doc-text.txt'), docText)

  // TOC toggle + paper-mode switch.
  click('[data-axv="toc-toggle"]')
  await waitFor('toc hidden', () => count('[data-axv="toc"]') === 0, 10000)
  assert(true, '[data-axv=toc-toggle] hides the table of contents')
  click('[data-axv="toc-toggle"]')
  await waitFor('toc shown', () => count('[data-axv="toc"]') >= 1, 10000)
  assert(true, '[data-axv=toc-toggle] shows the table of contents again')
  click('[data-axv="paper-mode-text"]')
  await waitFor('text mode', () => count('[data-axv="doc"]') === 0 && text('[data-axv="source-text"]').length > 20000, 15000)
  assert(count('[data-axv="source-text"]') === 1, 'text mode renders exactly one source-text hook (no nested wrapper)', `${count('[data-axv="source-text"]')}`)
  assert(attr('[data-axv="paper-mode-text"]', 'data-active') === 'true', 'paper-mode-text switches to the extracted plain text', `${text('[data-axv="source-text"]').length} chars`)
  click('[data-axv="paper-mode-doc"]')
  await waitFor('doc mode', () => count('[data-axv="doc"]') === 1, 15000)
  assert(true, 'paper-mode-doc switches back to the structured document')
  writeFileSync(path.join(artifactsDir, 'dom-source-text.txt'), docText)

  // Layout tabs: ai / source / split.
  click('[data-axv="mode-ai"]')
  await waitFor('mode-ai', () => /axv-mode-ai/.test(attr('[data-axv="workspace"]', 'class') ?? ''), 10000)
  assert(attr('[data-axv="mode-ai"]', 'data-active') === 'true', 'clicking AI switches the workspace to axv-mode-ai')
  click('[data-axv="mode-source"]')
  await waitFor('mode-source', () => /axv-mode-source/.test(attr('[data-axv="workspace"]', 'class') ?? ''), 10000)
  assert(attr('[data-axv="mode-source"]', 'data-active') === 'true', 'clicking source switches the workspace to axv-mode-source')
  click('[data-axv="mode-split"]')
  await waitFor('mode-split again', () => /axv-mode-split/.test(attr('[data-axv="workspace"]', 'class') ?? ''), 10000)
  assert(true, 'clicking split restores axv-mode-split')

  // Summary tab + streamed Chinese summary.
  await waitFor('[data-axv=summary] Chinese text', () => CJK.test(text('[data-axv="summary"]')), 150000)
  assert(true, '[data-axv=summary] streams Chinese text', `${text('[data-axv="summary"]').length} chars`)
  await waitFor('summary grows', () => text('[data-axv="summary"]').length > 200, 60000)
  assert(true, '[data-axv=summary] received a substantial summary', `${text('[data-axv="summary"]').length} chars`)
  assert(count('[data-axv="error"]') === 0, 'no error banner after the summary', text('[data-axv="error"]'))
  assert(text('[data-axv="summary"]').includes('一句话总结'), 'summary contains the 一句话总结 section')
  assert(text('[data-axv="summary"]').includes('核心贡献'), 'summary contains the 核心贡献 section')
  const summaryTextFinal = text('[data-axv="summary"]')
  const summaryRequest = aiRequests.find((body) => body.mode === 'summary')
  assert(summaryRequest !== undefined, 'summary used POST /dsh-arxiv/ai mode=summary', JSON.stringify(summaryRequest)?.slice(0, 160))
  assert(summaryRequest.provider === 'deepseek-account', 'summary request used the selected provider', summaryRequest.provider)
  assert(summaryRequest.reasoningEffort === 'low', 'summary request used the lowest advertised reasoning effort', String(summaryRequest.reasoningEffort))

  // Continue-QA button switches to the QA tab.
  click('[data-axv="continue-qa"]')
  await waitFor('qa tab', () => attr('[data-axv="ai-tab-qa"]', 'data-active') === 'true' && count('[data-axv="ask-input"]') === 1, 15000)
  assert(true, '[data-axv=continue-qa] switches the AI pane to the QA tab')
  assert(attr('[data-axv="ai-tab-summary"]', 'data-active') === 'false', 'summary tab is no longer active after continue-qa')

  // Q&A round.
  setInput('[data-axv="ask-input"]', '这篇论文的主要贡献是什么？')
  click('[data-axv="ask"]')
  await waitFor('[data-axv=answer]', () => {
    const answers = [...win.document.querySelectorAll('[data-axv="answer"]')]
    return answers.some((node) => (node.textContent ?? '').trim().length > 10)
  }, 180000)
  const answerText = [...win.document.querySelectorAll('[data-axv="answer"]')].at(-1)?.textContent ?? ''
  assert(answerText.trim().length > 10, '[data-axv=answer] streamed a non-empty answer', `${answerText.length} chars`)
  assert(count('[data-axv="messages"]') === 1, '[data-axv=messages] list exists', `${count('[data-axv="answer"]')} answer bubble(s)`)
  const qaRequest = aiRequests.find((body) => body.mode === 'qa')
  assert(qaRequest?.question?.includes('主要贡献'), 'QA request carries the question', qaRequest?.question)
  assert(qaRequest.model === 'deepseek-flash', 'QA used the model picked in the panel', qaRequest.model)
  assert(qaRequest.reasoningEffort === 'low', 'QA used the session reasoning effort', String(qaRequest.reasoningEffort))

  // ── attach/detach: panel action against the (fake) attach route ──────────
  await waitFor('attach button', () => count('[data-axv="attach"]') === 1, 15000)
  assert(attr('[data-axv="attach"]', 'data-attached') === 'false', 'paper starts unattached', String(attr('[data-axv="attach"]', 'data-attached')))
  const getAttachCall = attachCalls.find((call) => call.method === 'GET')
  assert(getAttachCall !== undefined, 'panel GETs /dsh-arxiv/attach for the target session', JSON.stringify(getAttachCall))
  assert(getAttachCall.sessionId === 'sess-beta', 'attach GET carries the switched target session', getAttachCall.sessionId)
  click('[data-axv="attach"]')
  await waitFor('attached', () => attr('[data-axv="attach"]', 'data-attached') === 'true', 20000)
  const attachPost = attachCalls.find((call) => call.method === 'POST' && call.paperId !== null)
  assert(attachPost !== undefined, 'clicking attach POSTs /dsh-arxiv/attach', JSON.stringify(attachPost))
  assert(attachPost.sessionId === 'sess-beta', 'attach POST carries the target session', attachPost.sessionId)
  assert(String(attachPost.paperId).includes('1706.03762'), 'attach POST carries the paper id', String(attachPost.paperId))
  await waitFor('attached notice', () => count('[data-axv="notice"]') === 1, 10000)
  assert(text('[data-axv="notice"]').length > 0, '[data-axv=notice] shows the attach confirmation', text('[data-axv="notice"]'))
  click('[data-axv="attach"]')
  await waitFor('detached', () => attr('[data-axv="attach"]', 'data-attached') === 'false', 20000)
  const detachPost = attachCalls.findLast((call) => call.method === 'POST')
  assert(detachPost.paperId === null, 'clicking attach again POSTs a detach (paperId null)', JSON.stringify(detachPost))
  click('[data-axv="attach"]')
  await waitFor('re-attached', () => attr('[data-axv="attach"]', 'data-attached') === 'true', 20000)

  // ── send to agent: faces.sendPrompt -> ctx.get('sessions').using -> prompt ─
  click('[data-axv="send-agent"]')
  await waitFor('agent prompt', () => promptCalls.length === 1, 20000)
  assert(promptCalls[0].sessionId === 'sess-beta', 'send-agent targets the selected session', promptCalls[0].sessionId)
  const promptText = promptCalls[0].parts.map((part) => part.text ?? '').join('')
  assert(promptText.includes('1706.03762'), 'send-agent prompt text contains the arXiv id', promptText.slice(0, 120))
  assert(promptText.includes('Attention Is All You Need'), 'send-agent prompt text contains the paper title', promptText.slice(0, 120))
  await waitFor('layout.selectPanel(null)', () => layoutCalls.includes(null), 10000)
  assert(true, 'send-agent returns to the conversation via layout.selectPanel(null)')
  assert(promptCalls[0].mode === 'queue', 'send-agent queues the prompt', String(promptCalls[0].mode))

  // Let the send notice expire, then send-selection with an empty selection.
  await waitFor('notice cleared', () => count('[data-axv="notice"]') === 0, 10000)
  click('[data-axv="send-selection"]')
  await waitFor('selection notice', () => count('[data-axv="notice"]') === 1, 10000)
  assert(text('[data-axv="notice"]').length > 0, 'send-selection reports an empty selection instead of sending', text('[data-axv="notice"]'))
  assert(promptCalls.length === 1, 'send-selection does not prompt when nothing is selected')

  const reactWarnings = consoleMessages.filter(([, message]) => /Warning:|unique "key"|not wrapped in act|Each child in a list/.test(message))
  assert(reactWarnings.length === 0, 'no React warnings/errors during the DOM run',
    reactWarnings.map(([kind, message]) => `${kind}: ${message.slice(0, 120)}`).join(' | '))

  writeFileSync(path.join(artifactsDir, 'dom-snapshot.html'), win.document.documentElement.outerHTML)
  writeFileSync(path.join(artifactsDir, 'dom-summary.txt'), text('[data-axv="summary"]'))
  writeFileSync(path.join(artifactsDir, 'dom-qa.txt'), answerText)
  console.log(`\nTITLE   ${text('[data-axv="title"]')}`)
  console.log(`SESSION ${text('[data-axv="session"]')}`)
  console.log(`DOC     ${docCounts.heading} headings, ${docCounts.paragraph} paragraphs, ${docCounts.table} tables, ${docCounts.figure} figures, ${docCounts.equation} equations, ${docCounts.toc} toc, ${docText.length} chars`)
  console.log(`SUMMARY ${summaryTextFinal.slice(0, 120).replace(/\n/g, ' ')}`)
  console.log(`ANSWER  ${answerText.slice(0, 120).replace(/\n/g, ' ')}`)
  console.log('saved test-artifacts/dom-snapshot.html')
} catch (error) {
  console.error(`\nFAILED: ${error?.message ?? String(error)}`)
  writeFileSync(path.join(artifactsDir, 'dom-snapshot-failure.html'), win.document.documentElement.outerHTML)
  console.error(`\n--- DOM text at failure ---\n${win.document.body.textContent?.slice(0, 3000) ?? ''}`)
  console.error(`--- ai requests ---\n${JSON.stringify(aiRequests, null, 2)?.slice(0, 1200)}`)
  console.error(`--- attach calls ---\n${JSON.stringify(attachCalls, null, 2)?.slice(0, 1200)}`)
  console.error(`--- prompt calls ---\n${JSON.stringify(promptCalls, null, 2)?.slice(0, 1200)}`)
  root.unmount()
  win.close()
  console.error(`\n${checks.filter((check) => check.ok).length}/${checks.length} checks passed`)
  process.exit(1)
}

root.unmount()
win.close()
const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
writeFileSync(path.join(artifactsDir, 'dom-report.json'), `${JSON.stringify({
  at: new Date().toISOString(),
  origin,
  paper: paperId,
  consoleMessages,
  checks,
}, null, 2)}\n`)
process.exit(0)
