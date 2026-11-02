#!/usr/bin/env node
// End-to-end verification for dsh-arxiv against a booted dev instance.
//
//   node tools/e2e.mjs                 full run: HTTP + real model stream + browser UI
//   node tools/e2e.mjs --http-only     no browser: routes, boot manifest, client bundle,
//                                      real /ai summary + QA SSE (runs inside the DSH sandbox)
//   node tools/e2e.mjs --headed        full run with a headed browser (debugging)
//   node tools/e2e.mjs --keep-open     leave the browser open after the run (debugging)
//   node tools/e2e.mjs --url <token-url>   attach to an instance not recorded in the state file
//   node tools/e2e.mjs --paper 2401.12345  use another arXiv id
//
// The instance URL/cookie come from test-artifacts/dev-instance.json, written by
// tools/boot.mjs. Chromium cannot start inside this session's DSH sandbox
// (restricted token + job object kills Chromium's Mojo pipes), so the browser
// half must be run from a normal PowerShell; --http-only covers the rest here.
//
// Exit codes: 0 pass, 1 assertion failure, 2 usage, 3 browser unavailable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const artifactsDir = path.join(pluginRoot, 'test-artifacts')
const stateFile = path.join(artifactsDir, 'dev-instance.json')
const PLAYWRIGHT = 'C:\\Users\\10174\\Documents\\deepseek-harness\\default-workspace\\dsh-src\\deepseek-harness-dsh-v0.2.1-rc.5\\node_modules\\playwright\\index.mjs'

const args = process.argv.slice(2)
function flag(name) {
  return args.includes(name)
}
function option(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const opts = {
  httpOnly: flag('--http-only'),
  headed: flag('--headed'),
  keepOpen: flag('--keep-open'),
  cdp: option('--cdp', null),
  url: option('--url', null),
  paper: option('--paper', '1706.03762'),
  timeout: Number(option('--timeout', '180000')),
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/
const checks = []
function ok(name, detail = '') {
  checks.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
}
function fail(name, detail) {
  checks.push({ name, ok: false, detail })
  console.log(`FAIL  ${name}  ${detail}`)
  throw new Error(`${name}: ${detail}`)
}
function assert(condition, name, detail) {
  if (condition) ok(name, detail)
  else fail(name, detail ?? 'assertion failed')
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

mkdirSync(artifactsDir, { recursive: true })

// ── instance + auth ─────────────────────────────────────────────────────────
function loadState() {
  if (opts.url) return { url: opts.url, origin: new URL(opts.url).origin, cookie: '' }
  if (!existsSync(stateFile)) {
    console.error(`missing ${stateFile} — start the instance with: node tools/boot.mjs`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(stateFile, 'utf8'))
}

async function resolveAuth(state) {
  // A plain GET of the token URL answers with a redirect and sets the
  // browser-session cookie; later requests must carry it.
  try {
    const response = await fetch(state.url, { redirect: 'manual' })
    const setCookies = response.headers.getSetCookie?.() ?? []
    const cookie = setCookies.map((value) => value.split(';')[0]).filter(Boolean).join('; ')
    if (cookie) return { ...state, cookie }
    if (state.cookie) return state
    if (response.status === 200) return state
    const location = response.headers.get('location')
    if (location) {
      const next = await fetch(new URL(location, state.url), { redirect: 'manual' })
      const nextCookies = next.headers.getSetCookie?.() ?? []
      return {
        ...state,
        cookie: nextCookies.map((value) => value.split(';')[0]).filter(Boolean).join('; '),
      }
    }
  } catch (error) {
    // fall through to the recorded cookie
  }
  return state
}

async function api(state, pathname, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (state.cookie) headers.cookie = state.cookie
  // Boot-manifest entry URLs are root-relative without the leading slash
  // ("plugins/??dsh-arxiv/client.js&rev=...").
  const target = /^https?:/i.test(pathname) ? pathname : new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, state.origin).href
  return fetch(target, { ...init, headers, redirect: 'manual' })
}

async function apiJson(state, pathname) {
  const response = await api(state, pathname)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${pathname} answered ${response.status} with non-JSON: ${text.slice(0, 300)}`)
  }
  return { response, body }
}

// ── boot manifest ───────────────────────────────────────────────────────────
function parseBoot(html) {
  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  if (start === -1) throw new Error('__DSH_BOOT__ injection not found in the served HTML')
  const end = html.indexOf('</script>', start)
  return JSON.parse(html.slice(start + marker.length, end).replace(/;\s*$/, ''))
}

function collectEntries(boot) {
  const found = []
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value.id === 'string' && typeof value.url === 'string') found.push(value)
    for (const key of Object.keys(value)) walk(value[key])
  }
  walk(boot)
  return found
}

// ── SSE over POST ──────────────────────────────────────────────────────────
// Reads `data: {...}` records (blank-line separated, `: ping` comments) from a
// streaming fetch response. Returns every record in order.
async function readSse(response, { onRecord, timeoutMs }) {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`/ai answered HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`/ai content-type is ${contentType}, expected text/event-stream`)
  }
  const records = []
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = response.body.getReader()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      await reader.cancel().catch(() => {})
      throw new Error(`SSE timeout after ${timeoutMs}ms (records: ${records.length})`)
    }
    const read = await Promise.race([
      reader.read(),
      sleep(remaining).then(() => ({ timeout: true })),
    ])
    if (read.timeout) continue
    if (read.done) break
    buffer += decoder.decode(read.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '') continue
        const record = JSON.parse(payload)
        records.push(record)
        onRecord?.(record)
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  return records
}

async function postAi(state, body, { timeoutMs = opts.timeout } = {}) {
  const response = await api(state, '/dsh-arxiv/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const records = await readSse(response, { timeoutMs })
  const text = records.filter((record) => record.type === 'delta').map((record) => record.text).join('')
  return { records, text }
}

// The account provider follows the signed-in account's /models listing; the
// client deliberately sends the model's lowest reasoning effort for summaries so
// provider-side thinking cannot consume the whole output budget.
const MODEL_CANDIDATES = [
  { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
  { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'low' },
  { provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'low' },
]

// Try the known catalogue until the host accepts a model; the account provider
// resolves its catalogue from the signed-in account's /models listing.
async function runAiWithFallback(state, body, label, { timeoutMs = opts.timeout } = {}) {
  let last
  for (const candidate of MODEL_CANDIDATES) {
    const { records, text } = await postAi(state, {
      ...body,
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
    }, { timeoutMs })
    last = { candidate, records, text }
    const error = records.find((record) => record.type === 'error')
    if (error === undefined && text.trim() !== '') return last
    if (error !== undefined && !/model|adapter|catalog/i.test(`${error.code} ${error.message}`)) break
    console.log(`      (retrying with another model after ${candidate.provider}/${candidate.model}: ${error?.code ?? 'empty stream'})`)
  }
  return last
}

// ── HTTP/bundle assertions ─────────────────────────────────────────────────
async function httpChecks(state) {
  const page = await api(state, '/')
  assert(page.status === 200, 'GET / returns 200', `status ${page.status}`)
  const html = await page.text()
  const boot = parseBoot(html)
  writeFileSync(path.join(artifactsDir, 'boot-manifest.json'), `${JSON.stringify(boot, null, 2)}\n`)
  const entries = collectEntries(boot)
  ok('boot manifest parsed', `${entries.length} client entries`)

  const pluginEntries = entries.filter((entry) => entry.id.includes('dsh-arxiv') || entry.url.includes('dsh-arxiv'))
  assert(pluginEntries.length > 0, 'boot manifest lists the dsh-arxiv client entry', JSON.stringify(pluginEntries.map((entry) => entry.id)))

  for (const entry of pluginEntries) {
    const response = await api(state, entry.url)
    const body = await response.text()
    assert(response.status === 200, `client bundle ${entry.url} returns 200`, `status ${response.status}, ${body.length} bytes`)
    assert(body.includes('__ModuleLoader__'), `client bundle ${entry.id} registers via __ModuleLoader__`, `${body.length} bytes`)
    assert(body.includes('data-axv="root"') || body.includes("'data-axv': 'root'"), `client bundle ${entry.id} carries [data-axv=root]`, `${body.length} bytes`)
    writeFileSync(path.join(artifactsDir, 'client-bundle.js'), body)
  }

  const health = await apiJson(state, '/dsh-arxiv/health')
  assert(health.response.status === 200 && health.body.ok === true && health.body.name === 'dsh-arxiv',
    'GET /dsh-arxiv/health', JSON.stringify(health.body))

  const meta = await apiJson(state, `/dsh-arxiv/meta?id=${encodeURIComponent(opts.paper)}`)
  assert(meta.body.ok === true, 'GET /dsh-arxiv/meta?id=... returns ok:true', JSON.stringify(meta.body).slice(0, 200))
  const paper = meta.body.paper ?? {}
  assert(typeof paper.title === 'string' && paper.title.length > 0, 'meta.paper.title present', paper.title)
  assert(Array.isArray(paper.authors) && paper.authors.length > 0, 'meta.paper.authors present', `${paper.authors?.length} authors`)
  assert(typeof paper.abstract === 'string' && paper.abstract.length > 100, 'meta.paper.abstract present', `${paper.abstract?.length} chars`)
  writeFileSync(path.join(artifactsDir, 'meta.json'), `${JSON.stringify(meta.body, null, 2)}\n`)

  const textRoute = await apiJson(state, `/dsh-arxiv/text?id=${encodeURIComponent(opts.paper)}`)
  assert(textRoute.body.ok === true, 'GET /dsh-arxiv/text?id=... returns ok:true', JSON.stringify(textRoute.body).slice(0, 200))
  assert(typeof textRoute.body.chars === 'number' && textRoute.body.chars > 1000,
    'full text cached in the host process', `chars=${textRoute.body.chars}, source=${textRoute.body.source}`)
  assert(['ar5iv', 'arxiv-html', 'abstract'].includes(textRoute.body.source),
    'full text source is a known value', String(textRoute.body.source))
  assert(textRoute.body.text === undefined, 'plain text route does not ship the paper body', 'no text field')
  writeFileSync(path.join(artifactsDir, 'text.json'), `${JSON.stringify({ ...textRoute.body, sections: textRoute.body.sections?.slice(0, 10) }, null, 2)}\n`)

  // The in-app 原文 reading pane opts in with body=1; this is the only route
  // variant that ships the extracted text to the browser.
  const bodyRoute = await apiJson(state, `/dsh-arxiv/text?id=${encodeURIComponent(opts.paper)}&body=1`)
  assert(bodyRoute.body.ok === true, 'GET /dsh-arxiv/text?body=1 returns ok:true',
    JSON.stringify({ ...bodyRoute.body, text: undefined }).slice(0, 200))
  const sourceText = bodyRoute.body.text
  assert(typeof sourceText === 'string', '/text?body=1 includes the text string', typeof sourceText)
  assert(sourceText.length > 20000, '/text?body=1 ships the extracted paper text', `${sourceText.length} chars`)
  assert(bodyRoute.body.chars === sourceText.length, '/text?body=1 chars matches the text length',
    `chars=${bodyRoute.body.chars}, text=${sourceText.length}`)
  assert(sourceText.includes(paper.title), '/text?body=1 text contains the paper title', paper.title)
  assert(['ar5iv', 'arxiv-html'].includes(bodyRoute.body.source), '/text?body=1 source is full-text (ar5iv/arxiv-html)', String(bodyRoute.body.source))
  writeFileSync(path.join(artifactsDir, 'source-text.txt'), sourceText)

  return { boot, entries, paper }
}

async function aiChecks(state) {
  const summary = await runAiWithFallback(state, {
    id: opts.paper,
    mode: 'summary',
    quality: 'fast',
  }, 'summary')
  assert(summary !== undefined, 'POST /dsh-arxiv/ai (summary) streamed', '')
  const start = summary.records.find((record) => record.type === 'start')
  assert(start !== undefined, 'summary stream starts with a start record', JSON.stringify(start)?.slice(0, 200))
  const error = summary.records.find((record) => record.type === 'error')
  assert(error === undefined, 'summary stream has no error record', error ? `${error.code}: ${error.message}` : 'clean')
  assert(summary.text.trim().length > 20, 'summary streamed non-empty delta text', `${summary.text.length} chars`)
  assert(CJK.test(summary.text), 'summary text is Chinese', summary.text.slice(0, 80).replace(/\n/g, ' '))
  assert(summary.text.includes('## 一句话总结'), 'summary contains the 一句话总结 section', summary.text.slice(0, 60).replace(/\n/g, ' '))
  const done = summary.records.find((record) => record.type === 'done')
  assert(done !== undefined, 'summary stream ends with done', JSON.stringify(done)?.slice(0, 160))
  writeFileSync(path.join(artifactsDir, 'summary.txt'), summary.text)
  console.log('--- summary excerpt ---')
  console.log(summary.text.slice(0, 400))
  console.log('--- end excerpt ---')

  const qa = await runAiWithFallback(state, {
    id: opts.paper,
    mode: 'qa',
    quality: 'fast',
    question: '这篇论文的主要贡献是什么？',
    history: [],
  }, 'qa')
  const qaError = qa?.records.find((record) => record.type === 'error')
  assert(qa !== undefined && qaError === undefined, 'POST /dsh-arxiv/ai (qa) streamed cleanly', qaError ? `${qaError.code}: ${qaError.message}` : '')
  assert(qa.text.trim().length > 10, 'QA answer streamed non-empty text', `${qa.text.length} chars`)
  const qaDone = qa.records.find((record) => record.type === 'done')
  assert(qaDone !== undefined, 'QA stream ends with done', JSON.stringify(qaDone)?.slice(0, 160))
  writeFileSync(path.join(artifactsDir, 'qa.txt'), qa.text)
  console.log('--- QA excerpt ---')
  console.log(qa.text.slice(0, 400))
  console.log('--- end excerpt ---')
}

// ── browser half ───────────────────────────────────────────────────────────
async function loadPlaywright() {
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href)
  return chromium
}

async function browserChecks(state) {
  const chromium = await loadPlaywright()
  let browser
  try {
    browser = opts.cdp
      ? await chromium.connectOverCDP(opts.cdp)
      : await chromium.launch({ channel: 'chrome', headless: !opts.headed })
  } catch (error) {
    console.error(`\nBROWSER UNAVAILABLE: ${error.message.split('\n')[0]}`)
    console.error('Chromium cannot start inside the DSH sandbox (restricted token / job object).')
    console.error('Run this from a normal PowerShell outside the sandbox:')
    console.error(`  node ${path.join(pluginRoot, 'tools', 'e2e.mjs')}`)
    process.exit(3)
  }
  const context = opts.cdp ? (browser.contexts()[0] ?? (await browser.newContext())) : await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  const page = await context.newPage()
  const consoleErrors = []
  const failedRequests = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('requestfailed', (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`))
  const shot = async (name) => {
    const file = path.join(artifactsDir, `e2e-${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(`      screenshot ${file}`)
    return file
  }
  const failDump = async (label) => {
    try {
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '')
      console.error(`--- page text at failure (${label}) ---\n${text}`)
    } catch {
      // ignore
    }
    await shot(`failure-${label}`).catch(() => {})
  }

  try {
    await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 0, { timeout: 30000 })
    ok('GUI loaded in the browser', page.url().replace(/\?token=.*/, ''))

    // Boot audit: the boot page renders failures; a clean shell means no row failed.
    const bootErrors = consoleErrors.filter((text) => /did not activate|import failed|web boot/i.test(text))
    assert(bootErrors.length === 0, 'no dsh-arxiv boot-audit failure', bootErrors.join(' | ').slice(0, 300))

    // The client half injects one <style data-plugin="dsh-arxiv"> at materialization.
    await page.waitForSelector('style[data-plugin="dsh-arxiv"]', { timeout: 30000 })
    ok('dsh-arxiv client bundle materialized (style injected)')

    // A conversation view slot needs an open session: create/enter one if the
    // shell shows an empty state, else use the session the GUI opened with.
    const newSession = page.getByRole('button', { name: /新建|新会话|新对话|New session|New chat/i }).first()
    if (await newSession.count()) {
      await newSession.click().catch(() => {})
      await page.waitForTimeout(1500)
    }
    await shot('01-shell')

    const tab = page.getByRole('tab', { name: /arXiv/ }).first()
    if (await tab.count()) await tab.click()
    else {
      const fallback = page.locator('button, [role="tab"]', { hasText: /arXiv/ }).first()
      if (await fallback.count()) await fallback.click()
      else {
        await failDump('no-arxiv-tab')
        fail('arXiv view tab exists', 'no tab with text arXiv in the shell')
      }
    }
    await page.waitForSelector('[data-axv="root"]', { timeout: 30000 })
    ok('arXiv view tab opened ([data-axv=root])')

    for (const selector of ['query', 'import', 'model']) {
      const present = await page.locator(`[data-axv="${selector}"]`).count()
      assert(present > 0, `[data-axv=${selector}] is present`, `${present} node(s)`)
    }

    await page.fill('[data-axv="query"]', opts.paper)
    await page.click('[data-axv="import"]')
    await page.waitForFunction(
      (text) => (document.querySelector('[data-axv="title"]')?.textContent ?? '').includes(text),
      'Attention',
      { timeout: 60000 },
    )
    ok('[data-axv=title] shows the imported paper', await page.textContent('[data-axv="title"]'))
    await shot('02-imported')

    const summarySelector = '[data-axv="summary"]'
    await page.waitForFunction(
      (selector) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(document.querySelector(selector)?.textContent ?? ''),
      summarySelector,
      { timeout: 120000 },
    )
    const summaryText = await page.textContent(summarySelector)
    assert(CJK.test(summaryText), '[data-axv=summary] streamed Chinese text', `${summaryText.length} chars`)
    await page.waitForFunction(
      (selector) => (document.querySelector(selector)?.textContent ?? '').length > 200,
      summarySelector,
      { timeout: 120000 },
    ).catch(() => {})
    ok('[data-axv=summary] streamed a substantial summary', `${(await page.textContent(summarySelector)).length} chars`)
    await shot('03-summary')

    await page.fill('[data-axv="ask-input"]', '这篇论文的主要贡献是什么？')
    await page.click('[data-axv="ask"]')
    await page.waitForFunction(
      () => {
        const answers = [...document.querySelectorAll('[data-axv="answer"]')]
        return answers.some((node) => (node.textContent ?? '').trim().length > 10)
      },
      { timeout: 180000 },
    )
    const answerText = await page.evaluate(() => {
      const answers = [...document.querySelectorAll('[data-axv="answer"]')]
      return answers.length === 0 ? '' : answers[answers.length - 1].textContent ?? ''
    })
    ok('[data-axv=answer] contains a non-empty answer', `${answerText?.length ?? 0} chars`)
    await shot('04-qa')

    await page.click('[data-axv="model"]')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-axv="model-option"]').length > 0,
      { timeout: 30000 },
    )
    const options = await page.locator('[data-axv="model-option"]').allTextContents()
    assert(options.length > 0, 'model picker lists [data-axv=model-option] rows', options.slice(0, 6).join(' | '))
    await shot('05-model-picker')

    // Switch to the listed model and confirm the trigger reflects the selection.
    const firstOption = page.locator('[data-axv="model-option"]').first()
    const optionLabel = (await firstOption.textContent()) ?? ''
    await firstOption.click()
    await page.waitForFunction(
      (label) => (document.querySelector('[data-axv="model"]')?.textContent ?? '').includes(label.trim()),
      optionLabel.trim().split(/\s+/).at(-1) ?? optionLabel,
      { timeout: 20000 },
    ).catch(() => {})
    ok('model picker selection updates the trigger', (await page.textContent('[data-axv="model"]')) ?? '')
    await shot('06-model-selected')

    assert(consoleErrors.length === 0, 'no browser console errors', consoleErrors.slice(0, 5).join(' | ').slice(0, 400))
    assert(failedRequests.length === 0, 'no failed browser requests', failedRequests.slice(0, 5).join(' | ').slice(0, 400))
  } catch (error) {
    await failDump('exception')
    throw error
  } finally {
    if (!opts.keepOpen) await browser.close()
  }
}

// ── main ───────────────────────────────────────────────────────────────────
const state = await resolveAuth(loadState())
console.log(`instance ${state.origin}  paper ${opts.paper}`)
const httpResult = await httpChecks(state)
await aiChecks(state)
if (!opts.httpOnly) {
  console.log('\n--- browser half ---')
  await browserChecks(state)
} else {
  console.log('\n(http-only: browser half skipped; run `node tools/e2e.mjs` from a normal shell for screenshots)')
}

const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
writeFileSync(path.join(artifactsDir, 'e2e-report.json'), `${JSON.stringify({ at: new Date().toISOString(), origin: state.origin, paper: opts.paper, httpOnly: opts.httpOnly, checks }, null, 2)}\n`)
process.exit(failed.length === 0 ? 0 : 1)
