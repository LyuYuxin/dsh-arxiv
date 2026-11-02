// arXiv metadata and full-text extraction for the dsh-arxiv plugin.
// Plain ESM, Node builtins only: global fetch/AbortSignal are provided by Node.
// Every network call is timeout-bounded and abortable; parse functions never throw.

const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; dsh-arxiv/0.1; +https://github.com/deepseek-ai/deepseek-harness)',
  accept: 'text/html,application/xhtml+xml,application/atom+xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
}

const ABS_BASE = 'https://arxiv.org/abs/'
const PDF_BASE = 'https://arxiv.org/pdf/'
const HTML_BASE = 'https://arxiv.org/html/'
const AR5IV_BASE = 'https://ar5iv.labs.arxiv.org/html/'
const API_BASE = 'https://export.arxiv.org/api/query'

/** Error type shared by every fetch helper; `code` is stable for the host route. */
export class ArxivError extends Error {
  /**
   * @param {'bad-id'|'not-found'|'network'|'timeout'|'parse'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ArxivError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// arXiv id parsing
// ---------------------------------------------------------------------------

// New style: YYMM.NNNN(N), e.g. 2401.12345 / 0704.0001. Version suffix is separate.
const MODERN_ID_RE = /(?<!\d)(\d{4}\.\d{4,5})(v\d+)?(?!\d)/i
// Old style: archive[.class]/YYMMNNN, e.g. cs/0112017, math.GT/0309136, hep-th/9901001.
const OLD_ID_RE = /(?<![0-9A-Za-z])([a-z][a-z-]*(?:\.[a-z-]+)?\/\d{7})(v\d+)?/i

/**
 * Extract an arXiv id from free-form text (ids, `arXiv:` prefixes, abs/pdf URLs, junk).
 * @param {unknown} input
 * @returns {{ id: string, baseId: string, version: string|null } | null}
 */
export function parseArxivId(input) {
  if (typeof input !== 'string') {
    if (input == null || typeof input === 'object') return null
    input = String(input)
  }
  const text = input.trim()
  if (!text) return null

  const modern = MODERN_ID_RE.exec(text)
  const old = OLD_ID_RE.exec(text)
  let match = null
  if (modern && old) match = modern.index <= old.index ? modern : old
  else match = modern || old
  if (!match) return null

  const baseId = match[1]
  if (!baseId || baseId.length > 64) return null
  const version = match[2] ? match[2].toLowerCase() : null
  return { id: baseId + (version || ''), baseId, version }
}

/** Accept a parsed object as well as a string (the host may pass through parsed ids). */
function coerceParsedId(input) {
  if (input && typeof input === 'object' && typeof input.baseId === 'string') {
    const baseId = input.baseId
    const version = typeof input.version === 'string' && /^v\d+$/i.test(input.version)
      ? input.version.toLowerCase()
      : null
    return { id: baseId + (version || ''), baseId, version }
  }
  return parseArxivId(input)
}

function idPath(baseId) {
  return String(baseId).split('/').map((part) => encodeURIComponent(part)).join('/')
}

// ---------------------------------------------------------------------------
// Network primitives
// ---------------------------------------------------------------------------

/**
 * Fetch a URL as text with a hard timeout, composing an optional caller signal.
 * @returns {Promise<{ status: number, text: string, url: string }>}
 */
async function fetchText(url, { signal, timeoutMs = 9000, headers = {} } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = Math.max(250, Number(timeoutMs) || 9000)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { ...DEFAULT_HEADERS, ...headers },
    })
    const text = await response.text()
    return { status: response.status, text, url: response.url || url }
  } catch (err) {
    if (signal?.aborted) throw new ArxivError('network', `arXiv request aborted: ${url}`)
    if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new ArxivError('timeout', `arXiv request timed out after ${timeout} ms: ${url}`)
    }
    throw new ArxivError('network', `arXiv request failed (${err?.message || err}): ${url}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function toArxivError(err) {
  if (err instanceof ArxivError) return err
  if (err?.name === 'AbortError') return new ArxivError('timeout', 'arXiv request aborted')
  return new ArxivError('network', String(err?.message || err || 'network error'))
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function mergeMetaErrors(absError, apiError) {
  if (apiError?.code === 'timeout' && absError?.code === 'timeout') {
    return new ArxivError('timeout', 'arXiv metadata lookup timed out')
  }
  if (apiError?.code === 'parse' && absError?.code === 'parse') {
    return new ArxivError('parse', 'could not parse arXiv metadata')
  }
  if (apiError?.code === 'timeout') {
    return new ArxivError('network', absError?.message || apiError.message)
  }
  const primary = apiError || absError
  return new ArxivError(primary?.code === 'parse' ? 'network' : (primary?.code || 'network'), primary?.message || 'arXiv metadata lookup failed')
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', middot: '\u00b7', bull: '\u2022',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', minus: '\u2212',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  le: '\u2264', ge: '\u2265', ne: '\u2260', asymp: '\u2248', sim: '\u223c', cong: '\u2245',
  equiv: '\u2261', infin: '\u221e', sum: '\u2211', prod: '\u220f', int: '\u222b', radic: '\u221a',
  rarr: '\u2192', larr: '\u2190', uarr: '\u2191', darr: '\u2193', harr: '\u2194',
  rArr: '\u21d2', lArr: '\u21d0', hArr: '\u21d4', forall: '\u2200', exist: '\u2203',
  isin: '\u2208', notin: '\u2209', sub: '\u2282', sup: '\u2283', sube: '\u2286', supe: '\u2287',
  cap: '\u2229', cup: '\u222a', and: '\u2227', or: '\u2228', not: '\u00ac',
  part: '\u2202', nabla: '\u2207', circ: '\u2218', prime: '\u2032', Prime: '\u2033',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5',
  varepsilon: '\u03f5', zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8', iota: '\u03b9',
  kappa: '\u03ba', lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be', pi: '\u03c0',
  rho: '\u03c1', sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5', phi: '\u03c6',
  chi: '\u03c7', psi: '\u03c8', omega: '\u03c9', Gamma: '\u0393', Delta: '\u0394',
  Theta: '\u0398', Lambda: '\u039b', Pi: '\u03a0', Sigma: '\u03a3', Phi: '\u03a6',
  Psi: '\u03a8', Omega: '\u03a9', thinsp: ' ', ensp: ' ', emsp: ' ',
}

function decodeEntities(value) {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return value
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
        return String.fromCodePoint(code)
      }
      return whole
    }
    if (Object.prototype.hasOwnProperty.call(ENTITY_MAP, body)) return ENTITY_MAP[body]
    const lower = body.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(ENTITY_MAP, lower)) return ENTITY_MAP[lower]
    return whole
  })
}

/** Strip tags, decode entities, collapse whitespace: one-line plain text. */
function cleanInline(fragment) {
  if (typeof fragment !== 'string' || !fragment) return ''
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Like cleanInline but keeps entities encoded, so `<` never leaks before tag stripping. */
function cleanInlineRaw(fragment) {
  if (typeof fragment !== 'string' || !fragment) return ''
  return fragment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseAttrs(tag) {
  const attrs = Object.create(null)
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let m
  while ((m = attrRe.exec(tag))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return attrs
}

function parseMetaTags(html) {
  const map = Object.create(null)
  const tagRe = /<meta\b[^>]*>/gi
  let match
  while ((match = tagRe.exec(html))) {
    const attrs = parseAttrs(match[0])
    const content = attrs.content
    if (typeof content !== 'string' || !content) continue
    const name = (attrs.name || attrs.property || attrs.itemprop || '').toLowerCase()
    if (!name) continue
    if (name === 'citation_author') {
      if (!Array.isArray(map[name])) map[name] = []
      map[name].push(content)
    } else if (map[name] === undefined) {
      map[name] = content
    }
  }
  return map
}

function normalizeDate(value) {
  const text = cleanInline(value)
  if (!text) return null
  const match = /(\d{4})[-/](\d{2})[-/](\d{2})/.exec(text)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  return text
}

/** Locate the raw HTML offset of the References/Bibliography heading (or -1). */
function findReferencesCut(html) {
  const headingRe = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi
  let match
  while ((match = headingRe.exec(html))) {
    const text = cleanInline(match[1])
    if (!text) continue
    if (/^(?:[\dIVX]+(?:\.\d+)*[.):]?\s*)?(?:references|bibliography|works cited)(?:\s|$)/i.test(text)) {
      return match.index
    }
  }
  return -1
}

/**
 * Synchronous, dependency-free HTML to plain text conversion used by fetchFullText.
 * Never throws; malformed input yields the best-effort text (possibly '').
 * @param {unknown} input
 * @returns {string}
 */
export function htmlToText(input) {
  try {
    if (typeof input !== 'string') {
      if (input == null) return ''
      input = String(input)
    }
    if (!input) return ''
    let html = input

    // Strip comments and cut everything from the references heading onward.
    html = html.replace(/<!--[\s\S]*?-->/g, ' ')
    const cut = findReferencesCut(html)
    if (cut > 0) html = html.slice(0, cut)

    // Drop document chrome. Head/title are removed without a `$` fallback so a
    // page with a missing `</head>` never loses its body.
    html = html.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ')

    // Drop non-content elements entirely (fallback to end-of-input for unclosed tags).
    html = html.replace(
      /<(script|style|noscript|nav|header|footer|svg|form|button|template|iframe|canvas|object)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      ' ',
    )

    // Math: keep TeX from alttext as $...$; drop the element when there is no alttext.
    html = html.replace(/<math\b([^>]*?)\/\s*>/gi, (whole, attrs) => mathAltText(attrs))
    html = html.replace(/<math\b([^>]*)>[\s\S]*?(?:<\/math\s*>|$)/gi, (whole, attrs) => mathAltText(attrs))

    // Headings: h1-h4 become markdown headings, h5/h6 become plain paragraphs.
    html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi, (whole, level, inner) => {
      const text = cleanInlineRaw(inner)
      if (!text) return '\n\n'
      return Number(level) <= 4 ? `\n\n## ${text}\n\n` : `\n\n${text}\n\n`
    })

    // Paragraph-ish boundaries.
    html = html.replace(/<br\b[^>]*\/?\s*>/gi, '\n')
    html = html.replace(/<\/(?:p|div|li|ul|ol|dl|dt|dd|figcaption|figure|blockquote|section|article|main|aside|table|thead|tbody|tfoot|tr|caption|pre|hr|h[1-6]|body|html)\s*>/gi, '\n\n')
    html = html.replace(/<(?:p|div|li|ul|ol|dl|dt|dd|figcaption|figure|blockquote|section|article|main|aside|table|thead|tbody|tfoot|tr|caption|pre|hr|h[1-6])\b[^>]*>/gi, '\n\n')

    // Everything else is inline markup; remove the tags but keep the text.
    html = html.replace(/<[^>]*>/g, ' ')

    let text = decodeEntities(html)
    text = text.replace(/\r\n?/g, '\n')
    text = text.replace(/[ \t\f\v]+/g, ' ')
    text = text.replace(/ *\n */g, '\n')
    text = text.replace(/\n{3,}/g, '\n\n')

    // Belt and braces: cut a references heading that survived the HTML pass.
    const textCut = /^##\s*(?:[\dIVX]+(?:\.\d+)*[.)]?\s*)?(?:references|bibliography|works cited)\b.*$/im.exec(text)
    if (textCut) text = text.slice(0, textCut.index)

    return text.replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return ''
  }
}

function mathAltText(attrs) {
  const match = /alttext\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
  if (!match) return ' '
  // Keep entities encoded until the final decode pass so a `<` in the TeX never
  // reaches the tag stripper. Raw `<` (malformed HTML) is escaped for the same reason.
  const tex = (match[1] ?? match[2] ?? '').trim().replace(/</g, '&lt;')
  return tex ? ` $${tex}$ ` : ' '
}

/**
 * Section headings (markdown `##`–`####` lines) extracted from converted paper text.
 * @param {unknown} text
 * @returns {string[]} heading names, trimmed, at most 40
 */
export function extractSections(text) {
  if (typeof text !== 'string' || !text) return []
  const sections = []
  for (const line of text.split('\n')) {
    const match = /^#{2,4}\s+(.*)$/.exec(line)
    if (!match) continue
    const name = match[1].replace(/\s*#+\s*$/, '').replace(/\s+/g, ' ').trim()
    if (!name) continue
    sections.push(name)
    if (sections.length >= 40) break
  }
  return sections
}

// ---------------------------------------------------------------------------
// Metadata parsing (abs page primary, export API fallback)
// ---------------------------------------------------------------------------

function parseSubjects(html, baseId) {
  const categories = []
  const block = /<td[^>]*class="[^"]*subjects[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(html)
  if (block) {
    const plain = cleanInline(block[1])
    for (const part of plain.split(';')) {
      const term = /\(([a-zA-Z][a-zA-Z-]*(?:\.[A-Za-z-]+)?)\)\s*$/.exec(part.trim())
      if (term && !categories.includes(term[1])) categories.push(term[1])
    }
  }
  let primaryCategory = null
  const primarySpan = /<span[^>]*class="[^"]*primary-subject[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(html)
  if (primarySpan) {
    const term = /\(([a-zA-Z][a-zA-Z-]*(?:\.[A-Za-z-]+)?)\)/.exec(cleanInline(primarySpan[1]))
    if (term) primaryCategory = term[1]
  }
  if (!primaryCategory && categories.length) primaryCategory = categories[0]
  if (!primaryCategory && typeof baseId === 'string' && baseId.includes('/')) {
    primaryCategory = baseId.split('/')[0]
  }
  return { primaryCategory, categories }
}

function tableCellText(html, className) {
  const re = new RegExp(`<td[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`, 'i')
  const match = re.exec(html)
  if (!match) return null
  const text = cleanInline(match[1])
  return text || null
}

function latestVersionFromHtml(html) {
  const cell = /<td[^>]*class="[^"]*arxividv[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(html)
  if (cell) {
    // The link text looks like "arXiv:1706.03762v7" (the `v` follows a digit), so
    // only require that no ASCII letter precedes it.
    const version = /(?<![a-zA-Z])(v\d+)(?![\w])/i.exec(cleanInline(cell[1]))
    if (version) return version[1].toLowerCase()
  }
  return null
}

function abstractFromBlockquote(html) {
  const match = /<blockquote[^>]*\bclass="[^"]*abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html)
  if (!match) return null
  const text = cleanInline(match[1]).replace(/^Abstract:\s*/i, '')
  return text || null
}

function parseAbsPage(html, requested) {
  const meta = parseMetaTags(html)
  const title = cleanInline(meta.citation_title || meta['og:title'] || '')
  if (!title) return null

  const authors = Array.isArray(meta.citation_author)
    ? meta.citation_author.map((author) => cleanInline(author)).filter(Boolean)
    : []
  const published = normalizeDate(meta.citation_date)
  const updated = normalizeDate(meta.citation_online_date) || published
  const abstract = cleanInline(meta.citation_abstract || '') || abstractFromBlockquote(html) || ''
  const version = requested.version || latestVersionFromHtml(html) || null
  const baseId = requested.baseId
  const { primaryCategory, categories } = parseSubjects(html, baseId)

  return {
    id: baseId + (version || ''),
    baseId,
    version,
    title,
    abstract,
    authors,
    published,
    updated,
    primaryCategory,
    categories,
    comment: tableCellText(html, 'comments'),
    journalRef: tableCellText(html, 'jref'),
    absUrl: ABS_BASE + baseId,
    pdfUrl: cleanInline(meta.citation_pdf_url || '') || PDF_BASE + baseId,
    htmlUrl: HTML_BASE + baseId,
  }
}

function parseApiFeed(xml, requested) {
  const entry = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/i.exec(xml)
  if (!entry) return null
  const body = entry[1]

  const tag = (name) => {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')
    const match = re.exec(body)
    return match ? match[1] : ''
  }

  const title = cleanInline(tag('title'))
  if (!title) return null
  const abstract = cleanInline(tag('summary'))
  const published = normalizeDate(tag('published'))
  const updated = normalizeDate(tag('updated')) || published
  const authors = [...body.matchAll(/<author(?:\s[^>]*)?>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    .map((match) => cleanInline(match[1]))
    .filter(Boolean)

  const feedId = parseArxivId(cleanInline(tag('id')))
  const baseId = requested.baseId
  const version = requested.version || feedId?.version || null

  let primaryCategory = null
  const primaryMatch = /<arxiv:primary_category\b[^>]*\bterm="([^"]+)"/i.exec(body)
  if (primaryMatch) primaryCategory = primaryMatch[1]
  const categories = []
  for (const match of body.matchAll(/<category\b[^>]*\bterm="([^"]+)"/gi)) {
    if (!categories.includes(match[1])) categories.push(match[1])
  }
  if (!primaryCategory && categories.length) primaryCategory = categories[0]

  return {
    id: baseId + (version || ''),
    baseId,
    version,
    title,
    abstract,
    authors,
    published,
    updated,
    primaryCategory,
    categories,
    comment: cleanInline(tag('arxiv:comment')) || null,
    journalRef: cleanInline(tag('arxiv:journal_ref')) || null,
    absUrl: ABS_BASE + baseId,
    pdfUrl: PDF_BASE + baseId,
    htmlUrl: HTML_BASE + baseId,
  }
}

/**
 * Fetch paper metadata. Primary source is the fast arxiv.org/abs page, with the
 * export API as fallback.
 * @param {string|{baseId:string,version?:string|null}} id
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<object>} Meta, throws ArxivError with `.code`
 */
export async function fetchMeta(id, { signal, timeoutMs = 9000 } = {}) {
  const requested = coerceParsedId(id)
  if (!requested) throw new ArxivError('bad-id', `Not a valid arXiv id: ${String(id)}`)

  const deadline = Date.now() + Math.max(1500, Number(timeoutMs) || 9000)
  let absError = null

  try {
    const res = await fetchText(ABS_BASE + idPath(requested.id), {
      signal,
      timeoutMs: Math.min(7000, Math.max(1000, deadline - Date.now())),
    })
    if (res.status === 404 || res.status === 410) {
      throw new ArxivError('not-found', `arXiv ${requested.id} was not found`)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ArxivError('network', `arXiv abstract page returned HTTP ${res.status}`)
    }
    const meta = parseAbsPage(res.text, requested)
    if (meta) return meta
    absError = new ArxivError('parse', 'could not parse the arXiv abstract page')
  } catch (err) {
    const error = toArxivError(err)
    if (signal?.aborted) throw error
    if (error.code === 'bad-id' || error.code === 'not-found') throw error
    absError = error
  }

  const remaining = deadline - Date.now()
  if (remaining < 400) {
    throw mergeMetaErrors(absError, new ArxivError('timeout', 'arXiv metadata lookup timed out'))
  }

  try {
    const url = `${API_BASE}?id_list=${encodeURIComponent(requested.baseId)}&max_results=1`
    const res = await fetchText(url, { signal, timeoutMs: Math.min(remaining, 9000) })
    if (res.status < 200 || res.status >= 300) {
      throw new ArxivError('network', `arXiv export API returned HTTP ${res.status}`)
    }
    const meta = parseApiFeed(res.text, requested)
    if (meta) return meta
    throw new ArxivError('not-found', `arXiv ${requested.baseId} was not found`)
  } catch (err) {
    const error = toArxivError(err)
    if (signal?.aborted) throw error
    if (error.code === 'bad-id' || error.code === 'not-found') throw error
    throw mergeMetaErrors(absError, error)
  }
}

// ---------------------------------------------------------------------------
// Full text extraction
// ---------------------------------------------------------------------------

function paperFromHtml(html) {
  const text = htmlToText(html)
  if (text.length < 400) return null
  const sections = extractSections(text)
  if (!sections.length && text.length < 2000) return null
  return { text, sections }
}

/**
 * Fetch the full paper text: ar5iv first (fast), arxiv.org/html as a bounded
 * fallback, and the abstract as the last resort. Never throws for network errors.
 * @param {string|{baseId:string,version?:string|null}} id
 * @param {object} [meta] metadata from fetchMeta (used for the abstract fallback)
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ source: 'ar5iv'|'arxiv-html'|'abstract', text: string, sections: string[] }>}
 */
export async function fetchFullText(id, meta, { signal, timeoutMs = 20000 } = {}) {
  const parsed = coerceParsedId(id) || coerceParsedId(meta)
  if (!parsed) throw new ArxivError('bad-id', `Not a valid arXiv id: ${String(id)}`)
  const baseId = (meta && typeof meta.baseId === 'string' && meta.baseId) || parsed.baseId
  const deadline = Date.now() + Math.max(2000, Number(timeoutMs) || 20000)

  // 1. ar5iv: primary source, one retry on 503/5xx.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining < 1200) break
    try {
      const res = await fetchText(AR5IV_BASE + idPath(baseId), {
        signal,
        timeoutMs: Math.min(9000, remaining),
      })
      if (res.status === 200) {
        const paper = paperFromHtml(res.text)
        if (paper) return { source: 'ar5iv', ...paper }
      }
      if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
        await delay(1500, signal)
        continue
      }
      break
    } catch (err) {
      const error = toArxivError(err)
      if (signal?.aborted) throw error
      if (attempt === 0) {
        await delay(1500, signal)
        continue
      }
      break
    }
  }

  // 2. arxiv.org/html: slow on some networks, so a hard bounded attempt only.
  const htmlRemaining = deadline - Date.now()
  if (htmlRemaining > 1200) {
    try {
      const res = await fetchText(HTML_BASE + idPath(baseId), {
        signal,
        timeoutMs: Math.min(12000, htmlRemaining),
      })
      if (res.status === 200) {
        const paper = paperFromHtml(res.text)
        if (paper) return { source: 'arxiv-html', ...paper }
      }
    } catch (err) {
      if (signal?.aborted) throw toArxivError(err)
    }
  }

  // 3. Abstract-only last resort.
  let resolvedMeta = meta && typeof meta === 'object' ? meta : null
  let abstract = resolvedMeta && typeof resolvedMeta.abstract === 'string' ? resolvedMeta.abstract.trim() : ''
  if (!abstract) {
    const remaining = deadline - Date.now()
    if (remaining > 800) {
      try {
        resolvedMeta = await fetchMeta(baseId, { signal, timeoutMs: Math.min(5000, remaining) })
        abstract = typeof resolvedMeta.abstract === 'string' ? resolvedMeta.abstract.trim() : ''
      } catch (err) {
        if (signal?.aborted) throw toArxivError(err)
      }
    }
  }
  return { source: 'abstract', text: abstract, sections: abstract ? ['Abstract'] : [] }
}
