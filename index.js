// Host half of dsh-arxiv.
//
// Routes (same-origin, used by the browser half in client.js):
//   GET  /dsh-arxiv/health                    -> { ok, name, version }
//   GET  /dsh-arxiv/meta?id=<id-or-url>       -> { ok, paper } | { ok:false, error }
//   GET  /dsh-arxiv/text?id=<id-or-url>       -> { ok, id, source, chars, sections }
//   POST /dsh-arxiv/ai                        -> text/event-stream of JSON records
//   GET  /dsh-arxiv/attach?sessionId=...      -> { ok, attached }
//   POST /dsh-arxiv/attach                    -> { ok, attached } (body: sessionId, paperId|null)
//
// The paper text never reaches the browser: the /ai route reads it from this
// process's cache and forwards streamed model deltas only. Model calls go
// through ctx.llm, so credentials, routes, and retry policy stay owned by DSH.
//
// v0.2 additions: the attach table above, a model-facing `arxiv` tool (registered
// through the optional `tools` service), and an `agent/pre-step` listener that
// tells the attached session's agent which paper the user is reading.

import {
  ArxivError,
  fetchFullText,
  fetchMeta,
  parseArxivId,
} from './src/arxiv.mjs'
import {
  attachView,
  createArxivTool,
  createAttachStore,
  createPreStepInjector,
} from './src/attach.mjs'
import { buildQaMessages, buildSummaryMessages } from './src/prompt.mjs'

export const name = 'dsh-arxiv'

/** The web server is the only required service; the LLM is resolved per request. */
export const inject = ['webServer']

const ROUTE = '/dsh-arxiv'
const VERSION = '0.2.0'
const CACHE_MAX = 20
const META_TTL_MS = 30 * 60 * 1000
const TEXT_TTL_MS = 30 * 60 * 1000
const META_TIMEOUT_MS = 10_000
const TEXT_TIMEOUT_MS = 20_000
const BODY_LIMIT = 96 * 1024
const PING_INTERVAL_MS = 15_000

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(text)
}

/** @param {unknown} error */
function errorBody(error) {
  const code = error instanceof ArxivError
    ? error.code
    : (typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal')
  return { ok: false, error: { code, message: String(error?.message ?? error) } }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {number} limit
 * @returns {Promise<unknown>}
 */
function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { code: 'bad-request' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'bad-request' }))
      }
    })
  })
}

/**
 * @param {string | null} value
 * @returns {ReturnType<typeof parseArxivId>}
 */
function requireId(value) {
  const id = parseArxivId(value)
  if (id === null) throw new ArxivError('bad-id', '无法识别的 arXiv ID')
  return id
}

/** Validate an attach route session id: non-empty string, at most 200 chars. */
function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 200) return null
  return trimmed
}

/** @param {import('node:http').ServerResponse} response */
function openSse(response) {
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-cache, no-transform')
  response.setHeader('connection', 'keep-alive')
  response.setHeader('x-accel-buffering', 'no')
  response.flushHeaders?.()
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} record
 * @returns {boolean} false once the socket is gone
 */
function writeSse(response, record) {
  if (response.writableEnded || response.destroyed) return false
  response.write(`data: ${JSON.stringify(record)}\n\n`)
  return true
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} body
 * @returns {{ id: NonNullable<ReturnType<typeof parseArxivId>>, mode: 'summary'|'qa', quality: 'fast'|'deep', question: string, history: {role:'user'|'assistant',content:string}[], provider: string, model: string, reasoningEffort: string|undefined }}
 */
function validateAiRequest(body) {
  if (!isRecord(body)) throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'bad-request' })
  const id = requireId(typeof body.id === 'string' ? body.id : null)
  const mode = body.mode
  if (mode !== 'summary' && mode !== 'qa') {
    throw Object.assign(new Error('mode 必须是 summary 或 qa'), { code: 'bad-request' })
  }
  const quality = body.quality === 'fast' ? 'fast' : 'deep'
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (provider === '' || provider.length > 200 || model === '' || model.length > 200) {
    throw Object.assign(new Error('缺少可用的模型（provider/model）'), { code: 'bad-request' })
  }
  const question = mode === 'qa' && typeof body.question === 'string' ? body.question.trim() : ''
  if (mode === 'qa' && question === '') {
    throw Object.assign(new Error('问题不能为空'), { code: 'bad-request' })
  }
  if (question.length > 4000) {
    throw Object.assign(new Error('问题过长'), { code: 'bad-request' })
  }
  /** @type {{role:'user'|'assistant',content:string}[]} */
  const history = []
  if (Array.isArray(body.history)) {
    for (const entry of body.history.slice(-12)) {
      if (!isRecord(entry)) continue
      const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null
      if (role === null || typeof entry.content !== 'string') continue
      const content = entry.content.trim()
      if (content === '') continue
      history.push({ role, content: content.slice(0, 8000) })
    }
  }
  const reasoningEffort = typeof body.reasoningEffort === 'string' && body.reasoningEffort !== ''
    ? body.reasoningEffort.slice(0, 100)
    : undefined
  return { id, mode, quality, question, history, provider, model, reasoningEffort }
}

export function apply(ctx, config = {}) {
  /** paper metadata keyed by base id */
  const metaCache = new Map()
  /** full text keyed by base id */
  const textCache = new Map()
  /** in-flight full-text fetches keyed by base id */
  const textInflight = new Map()
  /** session id -> attached paper metadata (LRU, at most 50 sessions) */
  const attachStore = createAttachStore()
  /** Memoized optional import for createUserMessage; the fallback keeps the plugin usable. */
  let llmModulePromise
  function loadLlmModule() {
    if (llmModulePromise === undefined) {
      llmModulePromise = import('@deepseek-ai/dsh-llm').catch(() => null)
    }
    return llmModulePromise
  }

  /** @param {Map<string, {at: number}>} cache @param {string} key */
  function touch(cache, key) {
    const entry = cache.get(key)
    if (entry === undefined) return undefined
    entry.at = Date.now()
    return entry
  }

  function prune(cache, ttl) {
    const now = Date.now()
    for (const [key, entry] of cache) {
      if (now - entry.at > ttl) cache.delete(key)
    }
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  /**
   * @param {NonNullable<ReturnType<typeof parseArxivId>>} id
   * @param {AbortSignal} [signal]
   */
  async function ensureMeta(id, signal) {
    const cached = touch(metaCache, id.baseId)
    if (cached !== undefined) return cached.paper
    const timeout = AbortSignal.timeout(META_TIMEOUT_MS)
    const meta = await fetchMeta(id, {
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    metaCache.set(id.baseId, { at: Date.now(), paper: meta })
    prune(metaCache, META_TTL_MS)
    return meta
  }

  /**
   * Resolve full text (or the abstract as the last resort) through one shared
   * in-flight fetch per paper.
   * @param {NonNullable<ReturnType<typeof parseArxivId>>} id
   */
  async function ensureText(id) {
    const cached = touch(textCache, id.baseId)
    if (cached !== undefined) return cached.text
    const running = textInflight.get(id.baseId)
    if (running !== undefined) return running
    /** @type {Promise<{ source: string, text: string, sections: string[] }>} */
    const task = (async () => {
      try {
        const meta = await ensureMeta(id)
        const timeout = AbortSignal.timeout(TEXT_TIMEOUT_MS)
        const text = await fetchFullText(id, meta, { signal: timeout })
        // An abstract-only result is a transient degradation: never pin it in
        // the 30-minute cache, so a later deep request retries the full text.
        if (text.source !== 'abstract') {
          textCache.set(id.baseId, { at: Date.now(), text })
          prune(textCache, TEXT_TTL_MS)
        }
        return text
      } finally {
        textInflight.delete(id.baseId)
      }
    })()
    textInflight.set(id.baseId, task)
    return task
  }

  /** @param {NonNullable<ReturnType<typeof parseArxivId>>} id @param {'fast'|'deep'} quality */
  async function paperTextFor(id, quality) {
    if (quality === 'deep') {
      try {
        return await ensureText(id)
      } catch {
        // A failed full-text fetch still leaves a usable abstract for the prompt.
      }
    }
    const meta = await ensureMeta(id)
    return { source: 'abstract', text: meta.abstract, sections: ['Abstract'] }
  }

  // Model-facing `arxiv` tool. The tools service is optional: register
  // immediately when it exists, otherwise wait for it through ctx.inject so a
  // composition that loads dsh-tools after this plugin still gets the tool.
  // Registration always runs as an effect on the scope that owns the service
  // (plugin ctx, or the inject callback's inner ctx), so a service reload or a
  // plugin unload re-registers/removes it cleanly.
  const arxivTool = createArxivTool({ attachStore, ensureMeta, ensureText, parseArxivId })
  function registerArxivTool(scope, registrar) {
    if (registrar === undefined || registrar === null || typeof registrar.register !== 'function') return
    scope.effect(() => registrar.register(arxivTool), 'dsh-arxiv: arxiv tool')
  }
  const tools = ctx.get('tools')
  if (tools !== undefined && tools !== null && typeof tools.register === 'function') {
    registerArxivTool(ctx, tools)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (inner) => {
      registerArxivTool(inner, inner.get('tools'))
    })
  }

  // Tell an attached session's agent which paper the user is reading. The
  // listener is a no-op for sessions without an attachment.
  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', createPreStepInjector({ attachStore, importLlm: loadLlmModule }))
  }

  const handlers = {
    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    health(_request, response) {
      sendJson(response, 200, { ok: true, name, version: VERSION })
    },

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    async meta(request, response) {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const id = requireId(url.searchParams.get('id'))
        const paper = await ensureMeta(id)
        sendJson(response, 200, { ok: true, paper })
      } catch (error) {
        sendJson(response, 200, errorBody(error))
      }
    },

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    async text(request, response) {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const id = requireId(url.searchParams.get('id'))
        // `body=1` returns the extracted text for the in-app 原文 reading pane;
        // the default stays metadata-only so AI calls never ship the paper body.
        const includeBody = url.searchParams.get('body') === '1'
          || url.searchParams.get('body') === 'true'
        const full = await ensureText(id)
        sendJson(response, 200, {
          ok: true,
          id: id.id,
          source: full.source,
          chars: full.text.length,
          sections: full.sections,
          ...(includeBody ? { text: full.text } : {}),
        })
      } catch (error) {
        sendJson(response, 200, errorBody(error))
      }
    },

    /**
     * Session attachment table used by the panel, the `arxiv` tool and the
     * pre-step injection. POST attaches/detaches one paper; GET reads.
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    async attach(request, response) {
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const sessionId = normalizeSessionId(url.searchParams.get('sessionId'))
          if (sessionId === null) {
            throw Object.assign(new Error('sessionId must be a non-empty string of at most 200 characters'), { code: 'bad-request' })
          }
          sendJson(response, 200, { ok: true, attached: attachView(attachStore.get(sessionId)) })
          return
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { code: 'method', message: 'GET or POST only' } })
          return
        }
        const body = await readJson(request, BODY_LIMIT)
        if (!isRecord(body)) {
          throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'bad-request' })
        }
        const sessionId = normalizeSessionId(body.sessionId)
        if (sessionId === null) {
          throw Object.assign(new Error('sessionId must be a non-empty string of at most 200 characters'), { code: 'bad-request' })
        }
        if (body.paperId === null) {
          sendJson(response, 200, { ok: true, attached: attachStore.detach(sessionId) })
          return
        }
        if (typeof body.paperId !== 'string') {
          throw Object.assign(new Error('paperId must be a string or null'), { code: 'bad-request' })
        }
        const id = requireId(body.paperId)
        const paper = await ensureMeta(id)
        sendJson(response, 200, { ok: true, attached: attachStore.attach(sessionId, paper) })
      } catch (error) {
        sendJson(response, 200, errorBody(error))
      }
    },

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    async ai(request, response) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: { code: 'method', message: 'POST only' } })
        return
      }
      let aiRequest
      try {
        aiRequest = validateAiRequest(await readJson(request, BODY_LIMIT))
      } catch (error) {
        sendJson(response, 200, { ok: false, error: { code: error?.code ?? 'bad-request', message: String(error?.message ?? error) } })
        return
      }

      openSse(response)
      const controller = new AbortController()
      let closed = false
      const ping = setInterval(() => {
        if (!closed && !response.writableEnded) response.write(': ping\n\n')
      }, PING_INTERVAL_MS)
      const finish = () => {
        clearInterval(ping)
        if (!response.writableEnded) response.end()
      }
      response.on('close', () => {
        if (response.writableEnded) return
        closed = true
        clearInterval(ping)
        controller.abort()
      })

      try {
        const meta = await ensureMeta(aiRequest.id, controller.signal)
        const paperText = await paperTextFor(aiRequest.id, aiRequest.quality)
        const prompt = aiRequest.mode === 'summary'
          ? buildSummaryMessages({ meta, text: paperText.text, fullText: paperText.source !== 'abstract' })
          : buildQaMessages({
              meta,
              text: paperText.text,
              fullText: paperText.source !== 'abstract',
              question: aiRequest.question,
              history: aiRequest.history,
            })
        writeSse(response, {
          type: 'start',
          paper: { id: meta.id, title: meta.title },
          source: paperText.source,
          model: `${aiRequest.provider}/${aiRequest.model}`,
        })
        if (closed) return

        const llm = ctx.get('llm')
        if (llm === undefined) {
          writeSse(response, { type: 'error', code: 'NO_ADAPTER', message: '当前 DSH 实例没有可用的模型服务' })
          return
        }

        let usage
        let chars = 0
        let visibleChars = 0
        let reasoningAnnounced = false
        for await (const chunk of llm.stream({
          provider: aiRequest.provider,
          model: aiRequest.model,
          // The caller chooses the effort: a quick-read summary asks for the
          // lowest advertised effort (no "high" thinking stall), Q&A keeps the
          // session's own effort. Omit for adapters that advertise none.
          ...(aiRequest.reasoningEffort === undefined ? {} : { reasoningEffort: aiRequest.reasoningEffort }),
          system: prompt.system,
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          temperature: prompt.temperature,
          signal: controller.signal,
        })) {
          if (closed) break
          if (chunk.type === 'text-delta') {
            chars += chunk.text.length
            visibleChars += chunk.text.trim().length
            if (!writeSse(response, { type: 'delta', text: chunk.text })) break
            continue
          }
          if (chunk.type === 'reasoning-delta') {
            // One progress marker is enough for the UI; reasoning text is not shown.
            if (!reasoningAnnounced) {
              reasoningAnnounced = true
              writeSse(response, { type: 'reasoning' })
            }
            continue
          }
          if (chunk.type === 'usage') {
            usage = chunk.usage
            continue
          }
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'stop' || chunk.reason.kind === 'max-tokens') {
              if (visibleChars === 0) {
                writeSse(response, {
                  type: 'error',
                  code: 'EMPTY_RESPONSE',
                  message: '模型没有产生可见输出（可能推理占满了输出额度）。请重试，或在 DSH 里换一个模型。',
                })
              } else {
                writeSse(response, { type: 'done', usage: usage ?? null, chars })
              }
            } else if (chunk.reason.kind === 'aborted') {
              if (!closed) writeSse(response, { type: 'error', code: 'ABORTED', message: '生成已取消' })
            } else {
              const failure = chunk.reason.failure
              writeSse(response, {
                type: 'error',
                code: String(failure?.code ?? 'LLM_ERROR'),
                message: String(failure?.message ?? failure ?? '模型请求失败'),
              })
            }
          }
        }
      } catch (error) {
        if (!closed) {
          const code = typeof error?.code === 'string' ? error.code : 'internal'
          writeSse(response, { type: 'error', code, message: String(error?.message ?? error) })
        }
      } finally {
        finish()
      }
    },
  }

  for (const [key, handler] of Object.entries(handlers)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/${key}`,
      handler: (request, response) => {
        Promise.resolve(handler(request, response)).catch((error) => {
          // Headers may already be out for a streaming response.
          if (!response.headersSent) sendJson(response, 500, errorBody(error))
          else response.end()
        })
      },
    }), `dsh-arxiv: ${key} route`)
  }

  // Config is accepted for future tuning but no field is required today.
  void config
}
