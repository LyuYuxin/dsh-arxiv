// dsh-arxiv v0.2 host additions: the per-session paper attachment store, the
// model-facing `arxiv` tool definition, and the `agent/pre-step` context
// injection. Pure ESM over injected dependencies; only Node builtins imported.

import { randomUUID } from 'node:crypto'

/** At most this many sessions keep an attached paper (LRU by last touch). */
export const ATTACH_MAX_SESSIONS = 50
/** Re-injecting the same paper for one session is suppressed for this long. */
export const INJECT_DEDUPE_MS = 10 * 60 * 1000
/** Upper bound for the pre-step dedupe bookkeeping map. */
export const INJECT_STATE_MAX_SESSIONS = 200
/** Model-visible source kind attached to injected context messages. */
export const INJECT_SOURCE_KIND = 'dsh-arxiv'
/** Reserved tool name. */
export const TOOL_NAME = 'arxiv'
/** Default and maximum character count for one `read` slice. */
export const TOOL_DEFAULT_LIMIT = 8000
export const TOOL_MAX_LIMIT = 20000
/** Bounds for the `search` action. */
export const TOOL_SEARCH_MAX_HITS = 8
export const TOOL_SEARCH_CONTEXT = 120

/**
 * JSON Schema for the `arxiv` tool arguments. The enforced tools subset accepts
 * object properties/required/additionalProperties and scalar enums; the tool
 * validates these values again in `execute` because a hand-written
 * ToolDefinition bypasses `defineTool` argument validation.
 */
export const ARXIV_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['current', 'meta', 'abstract', 'sections', 'read', 'search'],
    },
    id: { type: 'string', description: 'arXiv id (optional; defaults to the paper attached to this session)' },
    section: { type: 'string', description: 'Section name or heading substring for read' },
    query: { type: 'string', description: 'Literal search text for search' },
    offset: { type: 'number', description: 'Character offset for read (default 0)' },
    limit: { type: 'number', description: 'Characters to return (default 8000, max 20000)' },
  },
  required: ['action'],
  additionalProperties: false,
}

const NO_PAPER_TEXT = 'No arXiv id was provided and no paper is attached to this session. '
  + 'Pass id="<arXiv id>" or attach a paper in the dsh-arxiv panel first.'
const INVALID_ACTION_TEXT = 'Unknown action. Allowed actions: current, meta, abstract, sections, read, search.'

/** Project a stored paper onto the attach route's response shape. */
export function attachView(paper) {
  if (paper === null || paper === undefined) return null
  return {
    id: paper.id,
    baseId: paper.baseId,
    title: paper.title,
    primaryCategory: paper.primaryCategory ?? null,
    published: paper.published ?? null,
  }
}

/**
 * In-memory session -> paper attachment table with LRU eviction.
 * @param {{ maxSessions?: number }} [options]
 */
export function createAttachStore({ maxSessions = ATTACH_MAX_SESSIONS } = {}) {
  /** @type {Map<string, { paper: object, attachedAt: number }>} */
  const sessions = new Map()

  function touch(sessionId) {
    const entry = sessions.get(sessionId)
    if (entry === undefined) return undefined
    sessions.delete(sessionId)
    sessions.set(sessionId, entry)
    return entry
  }

  function evict() {
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }

  return {
    /** Attach a paper's metadata; returns the route-facing projection. */
    attach(sessionId, paper) {
      sessions.delete(sessionId)
      sessions.set(sessionId, { paper, attachedAt: Date.now() })
      evict()
      return attachView(paper)
    },
    /** Remove any attachment for the session. */
    detach(sessionId) {
      sessions.delete(sessionId)
      return null
    },
    /** @returns {object|null} the full stored metadata, touching LRU order. */
    get(sessionId) {
      const entry = touch(sessionId)
      return entry === undefined ? null : entry.paper
    },
    has(sessionId) {
      return sessions.has(sessionId)
    },
    get size() {
      return sessions.size
    },
  }
}

// ---------------------------------------------------------------------------
// Agent pre-step context injection
// ---------------------------------------------------------------------------

/** @param {unknown} agent */
function agentSessionId(agent) {
  const sessionId = agent?.session?.id
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
}

function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** Render the injected context text (roughly 400-800 characters). */
export function buildInjectionText(paper) {
  const id = oneLine(paper?.baseId) || oneLine(paper?.id) || 'unknown'
  const title = oneLine(paper?.title) || '(untitled)'
  const categories = Array.isArray(paper?.categories)
    ? paper.categories.filter((value) => typeof value === 'string' && value !== '')
    : []
  const category = oneLine(paper?.primaryCategory) || categories[0] || 'unknown'
  const text = `用户正在 DSH 的 arXiv 速读面板阅读 arXiv:${id}《${title}》（${category}）。`
    + '可调用 arxiv 工具：action=current 读取元信息与章节，action=read 读取正文片段，action=search 搜索正文。'
    + '回答涉及论文时请引用章节名。'
  const abstract = typeof paper?.abstract === 'string'
    ? paper.abstract.replace(/\s+/g, ' ').trim().slice(0, 400)
    : ''
  return abstract === '' ? text : `${text}\n\n摘要（前 400 字）：${abstract}`
}

/** Structural fallback used when `@deepseek-ai/dsh-llm` cannot be imported. */
function fallbackUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: INJECT_SOURCE_KIND,
      form: 'snapshot',
      sections: [{ name: INJECT_SOURCE_KIND, text }],
    },
  }
}

/**
 * Create the `agent/pre-step` listener that appends one context message for the
 * paper attached to the agent's session.
 * @param {{
 *   attachStore: ReturnType<typeof createAttachStore>,
 *   importLlm?: () => Promise<unknown>,
 *   dedupeMs?: number,
 * }} options
 * @returns {(event: object, next: () => Promise<object>) => Promise<object>}
 */
export function createPreStepInjector({ attachStore, importLlm, dedupeMs = INJECT_DEDUPE_MS }) {
  /** @type {Map<string, { paperId: string, at: number }>} */
  const lastInjected = new Map()

  function prune(now) {
    if (lastInjected.size <= INJECT_STATE_MAX_SESSIONS) return
    for (const [sessionId, entry] of lastInjected) {
      if (lastInjected.size <= INJECT_STATE_MAX_SESSIONS) break
      if (now - entry.at >= dedupeMs) lastInjected.delete(sessionId)
    }
  }

  return async function injectPreStepContext(event, next) {
    const decision = await next()
    if (decision === null || decision === undefined || decision.kind === 'reject') return decision
    if (event?.signal?.aborted) return decision
    const sessionId = agentSessionId(event?.agent)
    if (sessionId === null) return decision
    const paper = attachStore.get(sessionId)
    if (paper === null) return decision

    const paperId = oneLine(paper.baseId) || oneLine(paper.id) || 'unknown'
    const now = Date.now()
    const previous = lastInjected.get(sessionId)
    if (previous !== undefined && previous.paperId === paperId && now - previous.at < dedupeMs) {
      return decision
    }

    const text = buildInjectionText(paper)
    let message
    if (typeof importLlm === 'function') {
      try {
        const llm = await importLlm()
        if (llm !== null && typeof llm === 'object' && typeof llm.createUserMessage === 'function') {
          message = llm.createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: INJECT_SOURCE_KIND,
              form: 'snapshot',
              sections: [{ name: INJECT_SOURCE_KIND, text }],
            },
          })
        }
      } catch {
        message = undefined
      }
    }
    if (message === undefined) message = fallbackUserMessage(text)
    if (event?.signal?.aborted) return decision

    lastInjected.set(sessionId, { paperId, at: now })
    prune(now)
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    return { ...decision, messages: [...messages, message] }
  }
}

// ---------------------------------------------------------------------------
// Model-facing arxiv tool
// ---------------------------------------------------------------------------

function authorsText(meta) {
  if (!Array.isArray(meta?.authors)) return ''
  return meta.authors.filter((value) => typeof value === 'string' && value !== '').join(', ')
}

function categoriesText(value) {
  if (!Array.isArray(value)) return ''
  return value.filter((entry) => typeof entry === 'string' && entry !== '').join(', ')
}

/** Render complete metadata as plain text for the model. */
function formatMetaText(meta) {
  const abstract = typeof meta?.abstract === 'string' ? meta.abstract.trim() : ''
  const lines = [
    `arXiv: ${meta?.baseId ?? 'unknown'}${meta?.version ? ` (${meta.version})` : ''}`,
    `Title: ${oneLine(meta?.title) || '(unknown)'}`,
    `Authors: ${authorsText(meta) || '(unknown)'}`,
    `Published: ${oneLine(meta?.published) || '(unknown)'}${meta?.updated && meta.updated !== meta.published ? ` (updated ${oneLine(meta.updated)})` : ''}`,
    `Primary category: ${oneLine(meta?.primaryCategory) || '(unknown)'}`,
    `Categories: ${categoriesText(meta?.categories) || '(unknown)'}`,
  ]
  const comment = oneLine(meta?.comment)
  if (comment !== '') lines.push(`Comment: ${comment}`)
  const journalRef = oneLine(meta?.journalRef)
  if (journalRef !== '') lines.push(`Journal ref: ${journalRef}`)
  const links = [meta?.absUrl, meta?.pdfUrl, meta?.htmlUrl].filter((value) => typeof value === 'string' && value !== '')
  if (links.length > 0) lines.push(`Links: ${links.join(' | ')}`)
  lines.push('Abstract:', abstract === '' ? '(none)' : abstract)
  return lines.join('\n')
}

function sectionsOf(text) {
  const sections = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('## ')) continue
    const heading = line.slice(3).replace(/\s*#+\s*$/, '').trim()
    if (heading !== '') sections.push(heading)
  }
  return sections
}

function formatSectionsText(meta, sections) {
  const list = Array.isArray(sections) ? sections.filter((name) => typeof name === 'string' && name !== '') : []
  if (list.length === 0) {
    return `No section headings were found for arXiv:${meta?.baseId ?? 'unknown'} (full text may be unavailable; the abstract is still readable with action="abstract").`
  }
  return `arXiv:${meta?.baseId ?? 'unknown'} sections (${list.length}):\n`
    + list.map((name, index) => `${index + 1}. ${name}`).join('\n')
}

function formatCurrentText(meta, sections) {
  const abstract = typeof meta?.abstract === 'string' ? meta.abstract.trim() : ''
  const list = Array.isArray(sections) ? sections : []
  const lines = [
    'Current paper attached to this session.',
    `arXiv: ${meta?.baseId ?? 'unknown'}${meta?.version ? ` (${meta.version})` : ''}`,
    `Title: ${oneLine(meta?.title) || '(unknown)'}`,
    `Authors: ${authorsText(meta) || '(unknown)'}`,
    `Published: ${oneLine(meta?.published) || '(unknown)'}`,
    `Primary category: ${oneLine(meta?.primaryCategory) || '(unknown)'}`,
    'Abstract:',
    abstract === '' ? '(none)' : abstract,
  ]
  if (list.length > 0) {
    lines.push(`Sections (${list.length}):`, list.map((name, index) => `${index + 1}. ${name}`).join('\n'))
  } else {
    lines.push('Sections: full text is not available; read the abstract instead.')
  }
  lines.push('Next: action="read" with section/offset/limit for full text, or action="search" with query.')
  return lines.join('\n')
}

/**
 * Return the absolute offset of the first `## ` heading containing `needle`.
 * @returns {{ offset: number, heading: string } | null}
 */
function findSectionOffset(text, needle) {
  const lower = needle.toLowerCase()
  let position = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).replace(/\s*#+\s*$/, '').trim()
      if (heading.toLowerCase().includes(lower)) return { offset: position, heading }
    }
    position += line.length + 1
  }
  return null
}

function normalizeOffset(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.floor(numeric)
}

function normalizeLimit(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return TOOL_DEFAULT_LIMIT
  return Math.min(Math.floor(numeric), TOOL_MAX_LIMIT)
}

function readText(text, meta, args) {
  const total = text.length
  if (total === 0) return `arXiv:${meta?.baseId ?? 'unknown'} has no extracted full text.`
  const limit = normalizeLimit(args?.limit)
  const requestedOffset = normalizeOffset(args?.offset)
  const sectionName = oneLine(args?.section)
  let section = null
  let start = requestedOffset
  if (sectionName !== '') {
    section = findSectionOffset(text, sectionName)
    if (section === null) {
      const available = sectionsOf(text).slice(0, 12)
      return `Section "${sectionName}" not found in arXiv:${meta?.baseId ?? 'unknown'}. Available sections: ${available.join(' | ') || '(none)'}.`
    }
    start = section.offset + requestedOffset
  }
  if (start >= total) {
    return `Offset ${start} is past the end of arXiv:${meta?.baseId ?? 'unknown'} (${total} chars). `
      + `Use offset=0..${Math.max(0, total - 1)}${section === null ? '' : ` with section="${section.heading}"`}.`
  }
  const end = Math.min(total, start + limit)
  const header = `[offset ${start}/${total}] arXiv:${meta?.baseId ?? 'unknown'}`
    + `${section === null ? '' : ` section="${section.heading}"`}${end < total ? '' : ' (end)'}`
  const body = text.slice(start, end)
  const nextOffset = section === null ? end : end - section.offset
  const next = end < total
    ? `\nNext: call arxiv with action="read", id="${meta?.baseId ?? 'unknown'}", offset=${nextOffset}, limit=${limit}`
      + `${section === null ? '' : `, section="${section.heading}"`}.`
    : ''
  return `${header}\n${body}${next}`
}

function searchText(text, meta, args) {
  const query = oneLine(args?.query)
  if (query === '') return 'The search action needs a non-empty "query" string.'
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const hits = []
  let from = 0
  while (hits.length < TOOL_SEARCH_MAX_HITS) {
    const index = haystack.indexOf(needle, from)
    if (index === -1) break
    const start = Math.max(0, index - TOOL_SEARCH_CONTEXT)
    const end = Math.min(text.length, index + query.length + TOOL_SEARCH_CONTEXT)
    hits.push({ index, snippet: text.slice(start, end).replace(/\s+/g, ' ').trim() })
    from = index + Math.max(1, needle.length)
    if (from >= text.length) break
  }
  if (hits.length === 0) {
    return `No matches for "${query}" in arXiv:${meta?.baseId ?? 'unknown'} (${text.length} chars searched).`
  }
  return `Search "${query}" in arXiv:${meta?.baseId ?? 'unknown'}: ${hits.length} match(es) (max ${TOOL_SEARCH_MAX_HITS}).\n`
    + hits.map((hit, index) => `[${index + 1}] offset=${hit.index}: …${hit.snippet}…`).join('\n')
}

/**
 * Create the hand-written `arxiv` ToolDefinition. It is intentionally shaped
 * like the dsh-tools ToolDefinition without importing that package:
 * `{ name, description, parameters, output: { schema, render }, execute }`.
 * Registration validates `name`/`output.render`/`output.schema`; `execute`
 * always resolves to a string and never throws.
 * @param {{
 *   attachStore: ReturnType<typeof createAttachStore>,
 *   ensureMeta: (id: object) => Promise<object>,
 *   ensureText: (id: object) => Promise<{ source: string, text: string, sections: string[] }>,
 *   parseArxivId: (value: unknown) => { id: string, baseId: string, version: string|null } | null,
 * }} dependencies
 */
export function createArxivTool({ attachStore, ensureMeta, ensureText, parseArxivId }) {
  function attachedSessionId(exec) {
    return agentSessionId(exec?.agent)
  }

  async function resolveTarget(args, exec) {
    const explicit = oneLine(args?.id)
    if (explicit !== '') {
      const parsed = parseArxivId(explicit)
      if (parsed === null) return { error: `"${explicit}" is not a valid arXiv id.` }
      return { parsed }
    }
    const sessionId = attachedSessionId(exec)
    if (sessionId !== null) {
      const attached = attachStore.get(sessionId)
      if (attached !== null) {
        const parsed = parseArxivId(attached.baseId ?? attached.id)
        if (parsed !== null) return { parsed, attached }
      }
    }
    return { error: NO_PAPER_TEXT }
  }

  async function run(args, exec) {
    const action = oneLine(args?.action)
    if (action === 'current') {
      const sessionId = attachedSessionId(exec)
      const attached = sessionId === null ? null : attachStore.get(sessionId)
      if (attached === null) {
        return 'No paper is attached to this session. Ask the user to open the dsh-arxiv panel and attach one, '
          + 'or pass an explicit id with action="meta", "abstract", "sections", "read", or "search".'
      }
      const parsed = parseArxivId(attached.baseId ?? attached.id)
      let sections = []
      if (parsed !== null) {
        try {
          const full = await ensureText(parsed)
          sections = Array.isArray(full.sections) ? full.sections : []
        } catch {
          sections = []
        }
      }
      return formatCurrentText(attached, sections)
    }
    if (action !== 'meta' && action !== 'abstract' && action !== 'sections'
      && action !== 'read' && action !== 'search') {
      return INVALID_ACTION_TEXT
    }

    const target = await resolveTarget(args, exec)
    if (target.error !== undefined) return target.error
    const meta = await ensureMeta(target.parsed)
    if (action === 'meta') return formatMetaText(meta)
    if (action === 'abstract') {
      const abstract = typeof meta.abstract === 'string' ? meta.abstract.trim() : ''
      return abstract === '' ? `No abstract available for arXiv:${meta.baseId}.` : abstract
    }
    const full = await ensureText(target.parsed)
    const text = typeof full.text === 'string' ? full.text : ''
    if (action === 'sections') return formatSectionsText(meta, full.sections)
    if (action === 'read') return readText(text, meta, args)
    return searchText(text, meta, args)
  }

  return {
    name: TOOL_NAME,
    description: 'Read the arXiv paper the user is reading in the dsh-arxiv panel. '
      + 'action="current" returns the paper attached to this session; the other actions accept an explicit arXiv id '
      + '(defaulting to the attached paper). read pages through the extracted full text with offset/limit; '
      + 'search finds literal text. Returns plain text only; cite section names when answering.',
    parameters: ARXIV_TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      try {
        return await run(args, exec)
      } catch (error) {
        const message = typeof error?.message === 'string' && error.message !== ''
          ? error.message
          : String(error)
        return `arxiv tool failed: ${message}`
      }
    },
  }
}
