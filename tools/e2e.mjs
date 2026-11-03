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

async function apiJson(state, pathname, init = {}) {
  const response = await api(state, pathname, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${pathname} answered ${response.status} with non-JSON: ${text.slice(0, 300)}`)
  }
  return { response, body }
}

async function postJson(state, pathname, payload) {
  return apiJson(state, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// arxiv.org is slow/rate-limited from this network, so a cold /doc can answer
// with {ok:false,timeout}. Retry until the host has the structured document built.
async function docWithRetry(state, paperId, attempts = 4) {
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await apiJson(state, `/dsh-arxiv/doc?id=${encodeURIComponent(paperId)}`)
    if (last.body.ok === true) return last
    const code = last.body.error?.code ?? 'unknown'
    console.log(`      (/doc ${code} on attempt ${attempt}/${attempts}; retrying in 4s)`)
    if (code !== 'timeout' && code !== 'network') return last
    await sleep(4000)
  }
  return last
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

  // ── structured document for the typeset paper pane ───────────────────────
  const docRoute = await docWithRetry(state, opts.paper)
  assert(docRoute.body.ok === true, 'GET /dsh-arxiv/doc returns ok:true', JSON.stringify(docRoute.body).slice(0, 160))
  assert(['ar5iv', 'arxiv-html'].includes(docRoute.body.source), '/doc source is full-text', String(docRoute.body.source))
  const blocks = Array.isArray(docRoute.body.blocks) ? docRoute.body.blocks : []
  assert(blocks.length > 80, '/doc returns the structured block list', `${blocks.length} blocks`)
  const blockCounts = {}
  for (const block of blocks) blockCounts[block?.type ?? 'unknown'] = (blockCounts[block?.type ?? 'unknown'] ?? 0) + 1
  assert((blockCounts.heading ?? 0) >= 1, '/doc contains heading blocks', JSON.stringify(blockCounts))
  assert((blockCounts.paragraph ?? 0) >= 20, '/doc contains paragraph blocks', `${blockCounts.paragraph ?? 0} paragraphs`)
  assert((blockCounts.table ?? 0) >= 1, '/doc contains table blocks', `${blockCounts.table ?? 0} tables`)
  assert((blockCounts.figure ?? 0) >= 1, '/doc contains figure blocks', `${blockCounts.figure ?? 0} figures`)
  assert((blockCounts.equation ?? 0) >= 1, '/doc contains equation blocks', `${blockCounts.equation ?? 0} equations`)
  const blocksJson = JSON.stringify(blocks)
  assert(!/<[a-z][^>]*>/i.test(blocksJson), '/doc blocks carry no raw HTML strings', 'plain text/markup fields only')
  const docTitle = docRoute.body.sections?.[0]?.text ?? docRoute.body.title ?? ''
  assert(blocksJson.includes('Attention Is All You Need'), '/doc contains the paper title', String(docTitle).slice(0, 80))
  writeFileSync(path.join(artifactsDir, 'doc.json'), `${JSON.stringify({
    ok: docRoute.body.ok,
    id: docRoute.body.id,
    source: docRoute.body.source,
    sections: docRoute.body.sections?.length ?? 0,
    blocks: blocks.length,
    blockCounts,
  }, null, 2)}\n`)

  // ── /img proxy: allow-listed figure host passes, others get opaque 404 JSON ─
  const figure = blocks.find((block) => block?.type === 'figure' && typeof block.src === 'string' && block.src !== '')
  assert(figure !== undefined, '/doc exposes at least one figure image src', String(figure?.src))
  const img = await api(state, `/dsh-arxiv/img?src=${encodeURIComponent(figure.src)}`)
  const imgBytes = Buffer.from(await img.arrayBuffer())
  const imgType = img.headers.get('content-type') ?? ''
  assert(img.status === 200, 'GET /dsh-arxiv/img (allow-listed figure) returns 200', `status ${img.status}`)
  assert(/^image\//i.test(imgType), '/dsh-arxiv/img returns an image content-type', imgType)
  assert(imgBytes.length > 1000, '/dsh-arxiv/img returns the image bytes', `${imgBytes.length} bytes`)
  writeFileSync(path.join(artifactsDir, 'figure.bin'), imgBytes)
  const badHost = await api(state, `/dsh-arxiv/img?src=${encodeURIComponent('https://example.com/a.png')}`)
  const badHostBody = await badHost.json()
  assert(badHost.status === 404 && badHostBody.ok === false && badHostBody.error?.code === 'not-found',
    '/dsh-arxiv/img rejects a foreign host with 404 JSON', JSON.stringify(badHostBody))
  const missing = await api(state, '/dsh-arxiv/img')
  const missingBody = await missing.json()
  assert(missing.status === 404 && missingBody.ok === false, '/dsh-arxiv/img rejects a missing src with 404 JSON', JSON.stringify(missingBody))

  // ── session attachment round trip: POST attach -> GET -> detach -> GET ───
  // The host keeps a small attribution table; the panel, the `arxiv` tool and
  // the agent/pre-step context injection all read from it.
  const attachSession = `dsh-arxiv-e2e-${Date.now()}`
  const attach = await postJson(state, '/dsh-arxiv/attach', { sessionId: attachSession, paperId: opts.paper })
  assert(attach.body.ok === true, 'POST /dsh-arxiv/attach returns ok:true', JSON.stringify(attach.body).slice(0, 200))
  const attached = attach.body.attached ?? {}
  assert(attached.baseId === paper.baseId, 'attach record carries the paper baseId', JSON.stringify({ baseId: attached.baseId, id: attached.id }))
  assert(attached.title === paper.title, 'attach record carries the paper title', String(attached.title))
  assert(typeof attached.id === 'string' && typeof attached.published === 'string' && typeof attached.primaryCategory === 'string',
    'attach record carries id/published/primaryCategory', JSON.stringify({ id: attached.id, published: attached.published, category: attached.primaryCategory }))

  const attachGet = await apiJson(state, `/dsh-arxiv/attach?sessionId=${encodeURIComponent(attachSession)}`)
  assert(attachGet.body.ok === true && attachGet.body.attached?.baseId === paper.baseId,
    'GET /dsh-arxiv/attach returns the attached paper', JSON.stringify(attachGet.body).slice(0, 200))

  const detach = await postJson(state, '/dsh-arxiv/attach', { sessionId: attachSession, paperId: null })
  assert(detach.body.ok === true && detach.body.attached === null,
    'POST /dsh-arxiv/attach {paperId:null} detaches', JSON.stringify(detach.body).slice(0, 200))
  const afterDetach = await apiJson(state, `/dsh-arxiv/attach?sessionId=${encodeURIComponent(attachSession)}`)
  assert(afterDetach.body.ok === true && afterDetach.body.attached === null,
    'GET /dsh-arxiv/attach is empty after detach', JSON.stringify(afterDetach.body).slice(0, 200))

  const badAttach = await postJson(state, '/dsh-arxiv/attach', { sessionId: '', paperId: opts.paper })
  assert(badAttach.body.ok === false && badAttach.body.error?.code === 'bad-request',
    'POST /dsh-arxiv/attach rejects an empty sessionId with bad-request', JSON.stringify(badAttach.body).slice(0, 200))
  const badAttachGet = await apiJson(state, '/dsh-arxiv/attach')
  assert(badAttachGet.body.ok === false && badAttachGet.body.error?.code === 'bad-request',
    'GET /dsh-arxiv/attach rejects a missing sessionId with bad-request', JSON.stringify(badAttachGet.body).slice(0, 200))
  writeFileSync(path.join(artifactsDir, 'attach.json'), `${JSON.stringify({ sessionId: attachSession, attach: attach.body, detach: detach.body, bad: badAttach.body }, null, 2)}\n`)

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
  /** Viewport-sized screenshot for the 1440x900 / 1024x768 evidence shots. */
  const shotViewport = async (name) => {
    const file = path.join(artifactsDir, `e2e-${name}.png`)
    await page.screenshot({ path: file })
    console.log(`      screenshot ${file}`)
    return file
  }
  const viewportMetrics = () => page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }))
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

    // v0.2: the plugin is a left-sidebar global panel (no conversation view tab).
    // Dismiss the first-run welcome overlay if it is up, then click the sidebar
    // button whose accessible name is the panel label (arXiv).
    const welcome = page.getByRole('button', { name: /继续|Continue/ }).first()
    if (await welcome.count()) {
      await welcome.click().catch(() => {})
      await page.waitForTimeout(500)
    }
    await shot('01-shell')

    const sidebarEntry = page.getByRole('button', { name: /^arXiv$/ }).first()
    if (!(await sidebarEntry.count())) {
      await failDump('no-arxiv-sidebar')
      fail('sidebar arXiv entry exists', 'no button named arXiv in the sidebar')
    }
    await sidebarEntry.click()
    await page.waitForSelector('[data-axv="panel"]', { timeout: 30000 })
    ok('sidebar arXiv panel opened ([data-axv=panel])')
    assert(await page.locator('[data-axv="session"]').count() === 1, '[data-axv=session] target-session picker present')

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

    // v0.3 layout hooks: two top rows, meta row, split panes, AI tabs, paper modes.
    for (const selector of [
      'topbar', 'body', 'workspace', 'ai-pane', 'paper-pane', 'splitter',
      'ai-tab-summary', 'ai-tab-qa', 'paper-mode-doc', 'paper-mode-text', 'toc-toggle',
      'mode-split', 'mode-ai', 'mode-source', 'continue-qa', 'source', 'source-text',
      'attach', 'send-agent', 'send-selection', 'source-copy',
    ]) {
      assert(await page.locator(`[data-axv="${selector}"]`).count() === 1, `[data-axv=${selector}] present`)
    }
    // `.axv-import-row` / `.axv-meta-row` are the rendered class names; client.js
    // does not carry the data-axv hooks for them yet.
    assert(await page.locator('.axv-import-row').count() === 1, 'import row present (.axv-import-row)')
    assert(await page.locator('.axv-meta-row').count() === 1, 'meta row present (.axv-meta-row)')
    const wideMetrics = await viewportMetrics()
    assert(wideMetrics.innerWidth === 1440 && wideMetrics.innerHeight === 900, 'viewport is 1440x900', JSON.stringify(wideMetrics))
    assert(!wideMetrics.horizontalOverflow, 'panel has no horizontal overflow at 1440x900', JSON.stringify(wideMetrics))

    // Structured document for the paper pane.
    await page.waitForSelector('[data-axv="doc"]', { timeout: 90000 })
    const docMeta = await page.evaluate(() => {
      const doc = document.querySelector('[data-axv="doc"]')
      const count = (selector) => document.querySelectorAll(selector).length
      return {
        chars: (doc?.textContent ?? '').length,
        heading: count('[data-axv="doc-heading"]'),
        paragraph: count('[data-axv="doc-paragraph"]'),
        table: count('[data-axv="doc-table"]'),
        figure: count('[data-axv="doc-figure"]'),
        equation: count('[data-axv="doc-equation"]'),
        toc: count('[data-axv="toc"]'),
      }
    })
    assert(docMeta.chars > 20000, '[data-axv=doc] renders the paper text', `${docMeta.chars} chars`)
    assert(docMeta.heading >= 1 && docMeta.table >= 1 && docMeta.figure >= 1 && docMeta.equation >= 1,
      '[data-axv=doc] renders headings/tables/figures/equations', JSON.stringify(docMeta))
    assert(docMeta.toc >= 1, '[data-axv=toc] renders the table of contents', `${docMeta.toc} toc`)
    await shot('03-doc')

    // The dev profile has no workspace/session by default; the panel still opens,
    // imports and renders the paper, but models only load for a target session.
    const sessionText = (await page.textContent('[data-axv="session"]')) ?? ''
    const sessionless = /未选择|未选择会话|no session|select/i.test(sessionText) || sessionText.trim() === ''
    const screenshots = []
    if (!sessionless) {
      await page.waitForFunction(
        () => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(document.querySelector('[data-axv="summary"]')?.textContent ?? ''),
        { timeout: 150000 },
      )
      const summaryText = await page.textContent('[data-axv="summary"]')
      assert(CJK.test(summaryText), '[data-axv=summary] streamed Chinese text', `${summaryText.length} chars`)
      screenshots.push(await shotViewport('01-aiview'))

      // Follow-up question: continue-qa switches the AI pane to the QA tab.
      await page.click('[data-axv="continue-qa"]')
      await page.waitForFunction(
        () => document.querySelector('[data-axv="ai-tab-qa"]')?.getAttribute('data-active') === 'true',
        { timeout: 15000 },
      )
      await page.fill('[data-axv="ask-input"]', '这篇论文的主要贡献是什么？')
      await page.click('[data-axv="ask"]')
      await page.waitForFunction(
        () => [...document.querySelectorAll('[data-axv="answer"]')].some((node) => (node.textContent ?? '').trim().length > 10),
        { timeout: 180000 },
      )
      const answerText = await page.evaluate(() => {
        const answers = [...document.querySelectorAll('[data-axv="answer"]')]
        return answers.length === 0 ? '' : answers[answers.length - 1].textContent ?? ''
      })
      ok('[data-axv=answer] contains a non-empty answer', `${answerText?.length ?? 0} chars`)
      screenshots.push(await shotViewport('02-qa'))

      // Attach the current paper to the target session and confirm the toggle.
      const attachButton = page.locator('[data-axv="attach"]')
      if ((await attachButton.getAttribute('data-attached')) === 'false' && !(await attachButton.isDisabled())) {
        await attachButton.click()
        await page.waitForFunction(() => document.querySelector('[data-axv="attach"]')?.getAttribute('data-attached') === 'true', { timeout: 30000 })
        ok('[data-axv=attach] attached the paper to the session', 'data-attached=true')
      }
    } else {
      ok('panel works without a target session (summary/QA skipped)', sessionText.trim())
      screenshots.push(await shotViewport('01-aiview'))
    }

    // Splitter drag: flex-basis of the AI pane must change on pointer drag.
    const aiPaneBasics = () => page.evaluate(() => {
      const pane = document.querySelector('[data-axv="ai-pane"]')
      return { basis: pane?.style?.flexBasis ?? '', class: document.querySelector('[data-axv="workspace"]')?.className ?? '' }
    })
    const beforeDrag = await aiPaneBasics()
    const splitterBox = await page.locator('[data-axv="splitter"]').boundingBox()
    if (splitterBox !== null) {
      await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 140, splitterBox.y + splitterBox.height / 2, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(300)
    }
    const afterDrag = await aiPaneBasics()
    assert(afterDrag.basis !== beforeDrag.basis, 'dragging the splitter changes the AI pane flex-basis', `${beforeDrag.basis} -> ${afterDrag.basis}`)
    screenshots.push(await shotViewport('03-splitter'))

    // Narrow viewport: 1024x768, no horizontal overflow, panel still usable.
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.waitForTimeout(500)
    const narrowMetrics = await viewportMetrics()
    assert(narrowMetrics.innerWidth === 1024 && narrowMetrics.innerHeight === 768, 'narrow viewport is 1024x768', JSON.stringify(narrowMetrics))
    assert(!narrowMetrics.horizontalOverflow, 'panel has no horizontal overflow at 1024x768', JSON.stringify(narrowMetrics))
    screenshots.push(await shotViewport('04-narrow'))
    await page.setViewportSize({ width: 1440, height: 900 })
    writeFileSync(path.join(artifactsDir, 'screenshots.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      viewport: '1440x900',
      narrow: '1024x768',
      sessionless,
      screenshots,
      docMeta,
      wideMetrics,
      narrowMetrics,
      splitter: { before: beforeDrag.basis, after: afterDrag.basis },
    }, null, 2)}\n`)
    console.log(`      screenshots: ${screenshots.join(', ')}`)

    const pluginErrors = consoleErrors.filter((text) => /dsh-arxiv/i.test(text))
    assert(pluginErrors.length === 0, 'no dsh-arxiv browser console errors', pluginErrors.slice(0, 5).join(' | ').slice(0, 400))
    const failedPluginRequests = failedRequests.filter((text) => /dsh-arxiv/i.test(text))
    assert(failedPluginRequests.length === 0, 'no failed dsh-arxiv browser requests', failedPluginRequests.slice(0, 5).join(' | ').slice(0, 400))
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
