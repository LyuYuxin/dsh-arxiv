// Host-route regression tests for dsh-arxiv.
//
// Runs the real `apply()` from index.js against a fake Cordis context, fake
// Node request/response objects, a fake Llm stream and a monkeypatched
// `globalThis.fetch`, so the suite is fully offline. Run in-process:
//
//   node dsh-arxiv/test/host.test.mjs
//
// (`node --test` spawns child processes with pipes, which the DSH sandbox
// denies with EPERM; the in-process form exercises the same tests.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

import { apply } from '../index.js'
import { QA_SYSTEM, SUMMARY_SYSTEM } from '../src/prompt.mjs'

const AR5IV_HTML = readFileSync(new URL('./fixtures/ar5iv-1706.03762.html', import.meta.url), 'utf8')

const ABSTRACT =
  'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration.'

// Minimal abs page that exercises every metadata field index.js forwards.
const ABS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="citation_title" content="Attention Is All You Need" />
  <meta name="citation_author" content="Vaswani, Ashish" />
  <meta name="citation_author" content="Shazeer, Noam" />
  <meta name="citation_date" content="2017/06/12" />
  <meta name="citation_online_date" content="2023/08/02" />
  <meta name="citation_abstract" content="${ABSTRACT}" />
  <meta name="citation_pdf_url" content="https://arxiv.org/pdf/1706.03762" />
  <meta name="citation_arxiv_id" content="1706.03762" />
</head>
<body>
  <table>
    <tr><td class="tablecell comments mathjax">15 pages, 5 figures</td></tr>
    <tr><td class="tablecell subjects"><span class="primary-subject">Computation and Language (cs.CL)</span>; Machine Learning (cs.LG)</td></tr>
    <tr><td class="tablecell arxividv">(or <span class="arxivid"><a href="https://arxiv.org/abs/1706.03762v7">arXiv:1706.03762v7</a> [cs.CL]</span> for this version)</td></tr>
  </table>
</body>
</html>
`

const ARXIV_ID = '1706.03762'

/** Options of the most recent fake Llm stream call (one per AI test). */
let capturedStreamOptions = null

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Fake Cordis context: captures the four exact routes and serves the fake Llm. */
function createHost(llm) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(run) {
      const dispose = run()
      return () => dispose?.()
    },
    get(serviceName) {
      return serviceName === 'llm' ? llm : undefined
    },
  }
  apply(ctx, {})
  assert.equal(routes.size, 4, 'expected the four exact host routes')
  return routes
}

/** Fake Llm whose stream records the options it is called with. */
function fakeLlm(chunks, onStream) {
  return {
    stream(options) {
      onStream?.(options)
      return (async function* stream() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** Fake Llm that stalls after its first delta until the caller aborts the stream. */
function stallingLlm(state) {
  return {
    stream(options) {
      state.options = options
      return (async function* stream() {
        yield { type: 'text-delta', text: 'partial answer' }
        await new Promise((resolve) => {
          if (options.signal.aborted) return resolve()
          options.signal.addEventListener('abort', () => {
            state.aborted = true
            resolve()
          }, { once: true })
        })
      })()
    },
  }
}

function fakeRequest({ method = 'GET', url = '/', body, rawBody } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = {}
  request.destroy = () => {}
  process.nextTick(() => {
    if (rawBody !== undefined) request.emit('data', Buffer.from(rawBody))
    else if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
  })
  return request
}

function fakeResponse() {
  const response = new EventEmitter()
  response.statusCode = 200
  response.headers = {}
  response.chunks = []
  response.writableEnded = false
  response.destroyed = false
  response.headersSent = false
  response.setHeader = (name, value) => {
    response.headers[String(name).toLowerCase()] = String(value)
  }
  response.flushHeaders = () => {
    response.headersSent = true
  }
  response.write = (chunk) => {
    if (response.writableEnded) return false
    response.chunks.push(String(chunk))
    response.headersSent = true
    return true
  }
  response.end = (chunk) => {
    if (chunk !== undefined) response.chunks.push(String(chunk))
    if (!response.writableEnded) {
      response.writableEnded = true
      response.emit('close')
    }
    return response
  }
  return response
}

/** Start a route invocation; returns the live response plus a completion promise. */
function start(routes, path, options = {}) {
  const handler = routes.get(path)
  assert.equal(typeof handler, 'function', `missing route ${path}`)
  const response = fakeResponse()
  const request = fakeRequest({ method: options.method ?? 'GET', url: options.url ?? path, body: options.body, rawBody: options.rawBody })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${request.method} ${path}`)), 5000)
    response.on('close', () => {
      clearTimeout(timer)
      resolve(response)
    })
    try {
      handler(request, response)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
  return { response, request, done }
}

async function invoke(routes, path, options = {}) {
  const { response, done } = start(routes, path, options)
  await done
  return response
}

function jsonBody(response) {
  return JSON.parse(response.chunks.join(''))
}

function sseRecords(response) {
  const records = []
  for (const block of response.chunks.join('').split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const json = line.slice(5).trim()
      if (json !== '') records.push(JSON.parse(json))
    }
  }
  return records
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

/**
 * Run `run` with `globalThis.fetch` replaced by an arXiv mock. All URLs are
 * counted; unexpected URLs return 404 so a test can never reach the network.
 */
async function withArxivNetwork(run, { ar5iv = AR5IV_HTML, abs = ABS_HTML, html = null } = {}) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('ar5iv.labs.arxiv.org')) {
      return ar5iv === null ? new Response('missing', { status: 404 }) : new Response(ar5iv, { status: 200 })
    }
    if (target.includes('arxiv.org/html/')) {
      return html === null ? new Response('missing', { status: 404 }) : new Response(html, { status: 200 })
    }
    if (target.includes('arxiv.org/abs/')) {
      return abs === null ? new Response('missing', { status: 404 }) : new Response(abs, { status: 200 })
    }
    return new Response(`unexpected ${target}`, { status: 404 })
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test('GET /dsh-arxiv/health reports the plugin', async () => {
  const routes = createHost(fakeLlm([]))
  const response = await invoke(routes, '/dsh-arxiv/health')
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['content-type']), /application\/json/)
  assert.deepEqual(jsonBody(response), { ok: true, name: 'dsh-arxiv', version: '0.1.0' })
})

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('GET /meta returns metadata from the abs page', async () => {
  const routes = createHost(fakeLlm([]))
  await withArxivNetwork(async (calls) => {
    const response = await invoke(routes, '/dsh-arxiv/meta', {
      url: '/dsh-arxiv/meta?id=https://arxiv.org/abs/1706.03762v2',
    })
    const body = jsonBody(response)
    assert.equal(body.ok, true)
    assert.equal(body.paper.baseId, ARXIV_ID)
    assert.equal(body.paper.version, 'v2')
    assert.equal(body.paper.title, 'Attention Is All You Need')
    assert.deepEqual(body.paper.authors, ['Vaswani, Ashish', 'Shazeer, Noam'])
    assert.equal(body.paper.published, '2017-06-12')
    assert.equal(body.paper.updated, '2023-08-02')
    assert.equal(body.paper.primaryCategory, 'cs.CL')
    assert.deepEqual(body.paper.categories, ['cs.CL', 'cs.LG'])
    assert.equal(body.paper.comment, '15 pages, 5 figures')
    assert.equal(body.paper.abstract, ABSTRACT)
    assert.match(body.paper.absUrl, /arxiv\.org\/abs\/1706\.03762/)
    assert.ok(calls.length >= 1)
    assert.ok(calls[0].includes('arxiv.org/abs/1706.03762v2'))
  })
})

test('GET /meta rejects an invalid id with bad-id and no network call', async () => {
  const routes = createHost(fakeLlm([]))
  await withArxivNetwork(async (calls) => {
    const response = await invoke(routes, '/dsh-arxiv/meta', { url: '/dsh-arxiv/meta?id=definitely-not-an-id' })
    assert.equal(response.statusCode, 200)
    const body = jsonBody(response)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'bad-id')
    assert.equal(calls.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Full text route
// ---------------------------------------------------------------------------

test('GET /text returns ar5iv text and sections without the body', async () => {
  const routes = createHost(fakeLlm([]))
  await withArxivNetwork(async (calls) => {
    const response = await invoke(routes, '/dsh-arxiv/text', { url: '/dsh-arxiv/text?id=1706.03762' })
    const body = jsonBody(response)
    assert.equal(body.ok, true)
    assert.equal(body.id, '1706.03762')
    assert.equal(body.source, 'ar5iv')
    assert.ok(body.chars > 10000, `expected long text, got ${body.chars}`)
    assert.ok(Array.isArray(body.sections))
    assert.ok(body.sections.includes('1 Introduction'))
    assert.ok(!('text' in body), 'the paper body must stay in the host cache')
    assert.ok(calls.some((url) => url.includes('ar5iv.labs.arxiv.org')))
  })
})

test('GET /text falls back to the abstract when no html source works', async () => {
  const routes = createHost(fakeLlm([]))
  await withArxivNetwork(async () => {
    const response = await invoke(routes, '/dsh-arxiv/text', { url: '/dsh-arxiv/text?id=1706.03762' })
    const body = jsonBody(response)
    assert.equal(body.ok, true)
    assert.equal(body.source, 'abstract')
    assert.equal(body.chars, ABSTRACT.length)
    assert.deepEqual(body.sections, ['Abstract'])
  }, { ar5iv: null, html: null })
})

test('GET /text twice fetches the paper only once (cache + shared inflight)', async () => {
  const routes = createHost(fakeLlm([]))
  await withArxivNetwork(async (calls) => {
    const first = jsonBody(await invoke(routes, '/dsh-arxiv/text', { url: '/dsh-arxiv/text?id=1706.03762' }))
    const second = jsonBody(await invoke(routes, '/dsh-arxiv/text', { url: '/dsh-arxiv/text?id=1706.03762' }))
    assert.equal(first.source, 'ar5iv')
    assert.deepEqual(second.sections, first.sections)
    assert.equal(second.chars, first.chars)
    const ar5ivCalls = calls.filter((url) => url.includes('ar5iv.labs.arxiv.org'))
    const absCalls = calls.filter((url) => url.includes('arxiv.org/abs/'))
    assert.equal(ar5ivCalls.length, 1, `ar5iv fetched ${ar5ivCalls.length} times`)
    assert.equal(absCalls.length, 1, `abs page fetched ${absCalls.length} times`)
  })
})

// ---------------------------------------------------------------------------
// AI route: summary / QA SSE
// ---------------------------------------------------------------------------

test('POST /ai summary streams start/delta/done with the summary prompt', async () => {
  const routes = createHost(fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '## 一句话总结\n\n自注意力机制。' },
    { type: 'text-delta', index: 0, text: '\n\n## 核心贡献\n- 完全并行化' },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ], (options) => {
    capturedStreamOptions = options
  }))

  await withArxivNetwork(async () => {
    const response = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'summary', quality: 'deep', provider: 'fake-provider', model: 'fake-model' },
    })
    assert.match(String(response.headers['content-type']), /text\/event-stream/)
    assert.ok(response.writableEnded)

    const records = sseRecords(response)
    assert.deepEqual(records.map((record) => record.type), ['start', 'delta', 'delta', 'done'])
    assert.equal(records[0].paper.id, '1706.03762v7')
    assert.equal(records[0].paper.title, 'Attention Is All You Need')
    assert.equal(records[0].source, 'ar5iv')
    assert.equal(records[0].model, 'fake-provider/fake-model')
    assert.equal(records[1].text + records[2].text, '## 一句话总结\n\n自注意力机制。\n\n## 核心贡献\n- 完全并行化')
    assert.equal(records[3].chars, records[1].text.length + records[2].text.length)
    assert.deepEqual(records[3].usage, { inputTokens: 11, outputTokens: 7 })

    const options = capturedStreamOptions
    assert.equal(options.provider, 'fake-provider')
    assert.equal(options.model, 'fake-model')
    assert.equal(options.system, SUMMARY_SYSTEM)
    assert.equal(options.maxTokens, 3200)
    assert.equal(options.temperature, 0.3)
    assert.equal('reasoningEffort' in options, false, 'no caller effort means the adapter default')
    assert.equal(options.messages.length, 1)
    assert.equal(options.messages[0].role, 'user')
    const userText = options.messages[0].content[0].text
    assert.ok(userText.includes('Attention Is All You Need'))
    assert.ok(userText.includes('## 论文正文'))
  })
})

test('POST /ai QA streams an answer and ends with the question', async () => {
  const routes = createHost(fakeLlm([
    { type: 'text-delta', index: 0, text: '主要贡献是提出 Transformer。' },
    { type: 'usage', usage: { inputTokens: 21, outputTokens: 9 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ], (options) => {
    capturedStreamOptions = options
  }))

  await withArxivNetwork(async () => {
    const response = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: {
        id: ARXIV_ID,
        mode: 'qa',
        quality: 'deep',
        provider: 'fake-provider',
        model: 'fake-model',
        question: '这篇论文的主要贡献是什么？',
        history: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '请提问' },
        ],
      },
    })
    assert.match(String(response.headers['content-type']), /text\/event-stream/)
    const records = sseRecords(response)
    assert.deepEqual(records.map((record) => record.type), ['start', 'delta', 'done'])
    assert.equal(records[1].text, '主要贡献是提出 Transformer。')

    const options = capturedStreamOptions
    assert.equal(options.system, QA_SYSTEM)
    assert.equal(options.maxTokens, 2600)
    assert.equal(options.temperature, 0.3)
    const userText = options.messages[0].content[0].text
    assert.ok(userText.trimEnd().endsWith('Question: 这篇论文的主要贡献是什么？'))
    assert.ok(userText.includes('Previous Q&A:'))
    assert.ok(userText.includes('User: 你好'))
  })
})

test('POST /ai forwards the caller reasoningEffort for summary and QA', async () => {
  const routes = createHost(fakeLlm([
    { type: 'text-delta', text: 'ok' },
    { type: 'finish', reason: { kind: 'stop' } },
  ], (options) => {
    capturedStreamOptions = options
  }))

  await withArxivNetwork(async () => {
    await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'summary', quality: 'deep', provider: 'p', model: 'm', reasoningEffort: 'off' },
    })
    assert.equal(capturedStreamOptions.reasoningEffort, 'off')

    await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: {
        id: ARXIV_ID,
        mode: 'qa',
        quality: 'deep',
        provider: 'p',
        model: 'm',
        question: 'q?',
        reasoningEffort: 'high',
      },
    })
    assert.equal(capturedStreamOptions.reasoningEffort, 'high')
  })
})

test('POST /ai announces reasoning once as a progress record', async () => {
  const routes = createHost(fakeLlm([
    { type: 'reasoning-delta', text: 'thinking one' },
    { type: 'reasoning-delta', text: 'thinking two' },
    { type: 'text-delta', text: '## 一句话总结\n\n答案。' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))

  await withArxivNetwork(async () => {
    const response = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'summary', quality: 'deep', provider: 'p', model: 'm' },
    })
    const records = sseRecords(response)
    assert.deepEqual(records.map((record) => record.type), ['start', 'reasoning', 'delta', 'done'])
    assert.deepEqual(records[1], { type: 'reasoning' })
    assert.equal(records[3].chars, '## 一句话总结\n\n答案。'.length)
  })
})

test('POST /ai reports EMPTY_RESPONSE instead of done when no visible text was produced', async () => {
  const routes = createHost(fakeLlm([
    { type: 'reasoning-delta', text: 'reasoning only, no answer' },
    { type: 'usage', usage: { inputTokens: 40, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))

  await withArxivNetwork(async () => {
    const response = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'summary', quality: 'deep', provider: 'p', model: 'm' },
    })
    const records = sseRecords(response)
    assert.deepEqual(records.map((record) => record.type), ['start', 'reasoning', 'error'])
    assert.equal(records[2].code, 'EMPTY_RESPONSE')
    assert.ok(typeof records[2].message === 'string' && records[2].message.length > 0)
    assert.ok(!records.some((record) => record.type === 'done'))
    assert.ok(response.writableEnded)
  })
})

test('POST /ai fast quality uses the abstract and a JSON error for a bad body', async () => {
  const routes = createHost(fakeLlm([
    { type: 'text-delta', text: '摘要' },
    { type: 'finish', reason: { kind: 'stop' } },
  ], (options) => {
    capturedStreamOptions = options
  }))

  await withArxivNetwork(async (calls) => {
    const ok = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'summary', quality: 'fast', provider: 'p', model: 'm' },
    })
    const start = sseRecords(ok)[0]
    assert.equal(start.source, 'abstract')
    const userText = capturedStreamOptions.messages[0].content[0].text
    assert.ok(userText.includes('## 摘要（abstract）'))
    assert.equal(calls.filter((url) => url.includes('ar5iv')).length, 0, 'fast quality must not fetch full text')

    // Malformed JSON body: JSON error before any SSE stream exists.
    const malformed = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      rawBody: '{not valid json',
    })
    assert.match(String(malformed.headers['content-type']), /application\/json/)
    const malformedBody = jsonBody(malformed)
    assert.equal(malformedBody.ok, false)
    assert.equal(malformedBody.error.code, 'bad-request')
    assert.ok(!malformed.chunks.join('').includes('data:'))

    // Invalid provider/model: one JSON error record, still no SSE.
    const noModel = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'qa', quality: 'deep', provider: '', model: '' },
    })
    assert.match(String(noModel.headers['content-type']), /application\/json/)
    assert.equal(jsonBody(noModel).error.code, 'bad-request')
  })
})

test('POST /ai maps an Llm finish error to one SSE error record', async () => {
  const routes = createHost(fakeLlm([
    { type: 'text-delta', text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'missing credential' } } },
  ]))

  await withArxivNetwork(async () => {
    const response = await invoke(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'summary', quality: 'deep', provider: 'p', model: 'm' },
    })
    const records = sseRecords(response)
    assert.deepEqual(records.map((record) => record.type), ['start', 'delta', 'error'])
    assert.equal(records[2].code, 'AUTH')
    assert.equal(records[2].message, 'missing credential')
    assert.ok(response.writableEnded)
  })
})

test('POST /ai survives a client disconnect mid-stream without throwing', async () => {
  const state = { aborted: false, options: null }
  const routes = createHost(stallingLlm(state))

  await withArxivNetwork(async () => {
    const { response, done } = start(routes, '/dsh-arxiv/ai', {
      method: 'POST',
      url: '/dsh-arxiv/ai',
      body: { id: ARXIV_ID, mode: 'qa', quality: 'deep', provider: 'p', model: 'm', question: 'q?' },
    })

    await waitFor(() => response.chunks.join('').includes('"type":"delta"'))
    response.destroyed = true
    response.emit('close') // simulate the browser closing the connection
    await done
    await waitFor(() => response.writableEnded)

    assert.equal(state.aborted, true, 'the Llm stream signal must be aborted on disconnect')
    const records = sseRecords(response)
    assert.deepEqual(records.map((record) => record.type), ['start', 'delta'])
    assert.ok(!records.some((record) => record.type === 'error'), 'no error record after a client disconnect')
  })
})
