#!/usr/bin/env node
// Browser-half proof without a browser: mount the real dsh-arxiv client bundle in
// a DOM (happy-dom) + React 18, drive the real host routes (meta/text/ai SSE)
// through a fetch shim, and assert the stable `data-axv` hooks end to end.
//
//   node tools/client-dom.mjs [--paper 1706.03762]
//
// Why not a real browser: Chromium cannot start inside this session's DSH sandbox
// (the restricted token + job object deny Chromium's Mojo pipes, so Chrome/Edge
// die on startup). This exercises the same client.js the web app loads, with
// React, localStorage, a modelDirectories stub, and the live dev-host HTTP+SSE
// routes; only pixels/layout are missing. The full Playwright pass is tools/e2e.mjs.
//
// Exit codes: 0 pass, 1 assertion failure, 2 usage.

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// ── DOM environment ─────────────────────────────────────────────────────────
// happy-dom (not jsdom) because jsdom 29 needs Node >=22.13's require(ESM);
// this machine's node is 21.7. happy-dom is ESM and renders React 18 fine.
// The window must exist BEFORE react-dom is required: react-dom captures
// `canUseDOM`/window at module init and silently drops onChange delegation
// otherwise (clicks still work, text inputs do not).
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

// ── fetch shim: resolve relative /dsh-arxiv routes against the dev host and
//    attach the browser-session cookie, preserving streamed SSE bodies ──────
// Capture the real fetch before overriding globalThis.fetch (the client calls
// the bare global), otherwise the shim would call itself.
const nodeFetch = globalThis.fetch.bind(globalThis)
const aiRequests = []
globalThis.fetch = async (input, init = {}) => {
  const url = /^https?:/i.test(String(input)) ? String(input) : new URL(String(input), `${origin}/`).href
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

// ── fake plugin context: capture the conversation.view registration ────────
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
const registration = { spec: null, component: null, slotNames: [] }
const fakeCtx = {
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  get: (name) => (name === 'modelDirectories' ? modelDirectories : undefined),
  slots: {
    inject(name, callback) {
      registration.slotNames.push(name)
      callback()
    },
    register(spec, component) {
      registration.spec = spec
      registration.component = component
      return () => {}
    },
  },
}
mod.apply(fakeCtx)
assert(registration.slotNames.includes('conversation.view'), 'apply() injects into the conversation.view slot', registration.slotNames.join(','))
assert(registration.component !== null, 'conversation.view component captured')
assert(registration.spec?.id === 'arxiv', 'view tab id is arxiv', JSON.stringify(registration.spec))
assert(win.document.querySelector('style[data-plugin="dsh-arxiv"]') !== null, 'apply() injects the axv style element')

// ── render the view ────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(win.document.getElementById('app'))
root.render(React.createElement(registration.component, { sessionId: 'dom-session' }))
const text = (selector) => win.document.querySelector(selector)?.textContent ?? ''
const count = (selector) => win.document.querySelectorAll(selector).length
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

try {
  await waitFor('[data-axv=root]', () => count('[data-axv="root"]') === 1, 15000)
  assert(true, '[data-axv=root] rendered')
  for (const selector of ['query', 'import', 'model']) {
    assert(count(`[data-axv="${selector}"]`) > 0, `[data-axv=${selector}] present`)
  }

  // model picker: open, list grouped rows, switch models, and switch back
  click('[data-axv="model"]')
  await waitFor('model options', () => count('[data-axv="model-option"]') === 2, 10000)
  const optionLabels = [...win.document.querySelectorAll('[data-axv="model-option"]')].map((node) => node.textContent)
  assert(optionLabels.length === 2, 'model picker lists model-option rows', optionLabels.join(' | '))
  assert(text('[data-axv="model"]').includes('DeepSeek-V4.1-Flash'), 'model trigger shows the current model', text('[data-axv="model"]'))
  const proOption = [...win.document.querySelectorAll('[data-axv="model-option"]')].find((node) => node.textContent.includes('V4-Pro'))
  proOption.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('model switch', () => text('[data-axv="model"]').includes('DeepSeek-V4-Pro'), 15000)
  assert(modelState.selectCalls.length === 1, 'clicking a model row calls modelDirectories.select()', JSON.stringify(modelState.selectCalls[0]))
  assert(modelState.selectCalls[0]?.provider === 'deepseek-account', 'model selection carries the provider', JSON.stringify(modelState.selectCalls[0]))
  assert(count('[data-axv="model-option"]') === 0, 'model picker closes after selecting')

  click('[data-axv="model"]')
  await waitFor('model options again', () => count('[data-axv="model-option"]') === 2, 10000)
  const flashOption = [...win.document.querySelectorAll('[data-axv="model-option"]')].find((node) => node.textContent.includes('V4.1-Flash'))
  flashOption.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('model switch back', () => text('[data-axv="model"]').includes('DeepSeek-V4.1-Flash'), 15000)
  assert(modelState.selectCalls.length === 2, 'a second model switch reaches the directory', JSON.stringify(modelState.selectCalls[1]))

  // import the paper: real /meta + /text, then the streamed /ai summary
  setInput('[data-axv="query"]', paperId)
  assert(win.document.querySelector('[data-axv="query"]')?.value === paperId, '[data-axv=query] accepts the arXiv id', String(win.document.querySelector('[data-axv="query"]')?.value))
  assert(win.document.querySelector('[data-axv="import"]')?.disabled === false, '[data-axv=import] is enabled once the id is typed')
  click('[data-axv="import"]')
  // The status line only renders while something is in flight (importing /
  // loading full text / model), so it is asserted at import time, not at rest.
  await waitFor('[data-axv=status] during import', () => count('[data-axv="status"]') === 1, 15000)
  assert(true, '[data-axv=status] appears while importing', text('[data-axv="status"]'))
  await waitFor('[data-axv=title]', () => text('[data-axv="title"]').includes('Attention'), 60000)
  assert(true, '[data-axv=title] shows the imported paper', text('[data-axv="title"]'))
  assert(text('[data-axv="title"]').length > 20, 'title is the full paper title', text('[data-axv="title"]'))

  await waitFor('[data-axv=summary] Chinese text', () => CJK.test(text('[data-axv="summary"]')), 150000)
  assert(true, '[data-axv=summary] streams Chinese text', `${text('[data-axv="summary"]').length} chars`)
  await waitFor('summary grows', () => text('[data-axv="summary"]').length > 200, 60000)
  assert(true, '[data-axv=summary] received a substantial summary', `${text('[data-axv="summary"]').length} chars`)
  assert(count('[data-axv="error"]') === 0, 'no error banner after the summary', text('[data-axv="error"]'))

  const summaryRequest = aiRequests.find((body) => body.mode === 'summary')
  assert(summaryRequest !== undefined, 'summary used POST /dsh-arxiv/ai mode=summary', JSON.stringify(summaryRequest)?.slice(0, 160))
  assert(summaryRequest.provider === 'deepseek-account', 'summary request used the selected provider', summaryRequest.provider)
  assert(summaryRequest.reasoningEffort === 'low', 'summary request used the lowest advertised reasoning effort', String(summaryRequest.reasoningEffort))
  // Markdown is rendered into headings, so the DOM text carries the section
  // names without the leading `##` that the raw SSE bytes (checked in e2e.mjs) have.
  assert(text('[data-axv="summary"]').includes('一句话总结'), 'summary contains the 一句话总结 section', text('[data-axv="summary"]').slice(0, 80).replace(/\n/g, ' '))
  assert(text('[data-axv="summary"]').includes('核心贡献'), 'summary contains the 核心贡献 section', text('[data-axv="summary"]').slice(0, 80).replace(/\n/g, ' '))

  // Q&A round
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
  assert(qaRequest.model === 'deepseek-flash', 'QA used the model picked in the view', qaRequest.model)
  assert(qaRequest.reasoningEffort === 'low', 'QA used the session reasoning effort', String(qaRequest.reasoningEffort))

  writeFileSync(path.join(artifactsDir, 'dom-snapshot.html'), win.document.documentElement.outerHTML)
  writeFileSync(path.join(artifactsDir, 'dom-summary.txt'), text('[data-axv="summary"]'))
  writeFileSync(path.join(artifactsDir, 'dom-qa.txt'), answerText)
  console.log(`\nTITLE   ${text('[data-axv="title"]')}`)
  console.log(`SUMMARY ${text('[data-axv="summary"]').slice(0, 120).replace(/\n/g, ' ')}`)
  console.log(`ANSWER  ${answerText.slice(0, 120).replace(/\n/g, ' ')}`)
  console.log('saved test-artifacts/dom-snapshot.html')
} catch (error) {
  console.error(`\nFAILED: ${error?.message ?? String(error)}`)
  writeFileSync(path.join(artifactsDir, 'dom-snapshot-failure.html'), win.document.documentElement.outerHTML)
  console.error(`\n--- DOM text at failure ---\n${win.document.body.textContent?.slice(0, 3000) ?? ''}`)
  console.error(`--- ai requests ---\n${JSON.stringify(aiRequests, null, 2)?.slice(0, 1200)}`)
  root.unmount()
  win.close()
  console.error(`\n${checks.filter((check) => check.ok).length}/${checks.length} checks passed`)
  process.exit(1)
}

root.unmount()
win.close()
const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
writeFileSync(path.join(artifactsDir, 'dom-report.json'), `${JSON.stringify({ at: new Date().toISOString(), origin, paper: paperId, checks }, null, 2)}\n`)
process.exit(0)
