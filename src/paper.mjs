// Structured paper extraction for dsh-arxiv v0.3.
//
// Converts ar5iv / arxiv.org HTML into the block document the client renders as
// a typeset paper: reading-order headings, paragraphs, lists, tables, figures,
// display equations and quotes. Pure ESM with no imports, matching the other
// `src/*.mjs` modules.

/** Hard cap on emitted blocks; `sections` is retained beyond the cap. */
export const MAX_BLOCKS = 2000
/** Skip absurdly large HTML documents instead of parsing them in-process. */
const MAX_HTML_CHARS = 12_000_000
const AR5IV_ROOT = 'https://ar5iv.labs.arxiv.org/html/'
const ARXIV_HTML_ROOT = 'https://arxiv.org/html/'
const FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; dsh-arxiv/0.3; +https://github.com/deepseek-ai/deepseek-harness)',
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
}

// ---------------------------------------------------------------------------
// HTML entities
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
  zwj: '', zwnj: '',
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

function normalizeText(value) {
  if (typeof value !== 'string') return ''
  let text = value
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/ ([.,;:!?%)\]])/g, '$1')
  return text
}

// ---------------------------------------------------------------------------
// Minimal HTML tree parser
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  'head', 'title', 'meta', 'link', 'base', 'script', 'style', 'noscript',
  'nav', 'header', 'footer', 'svg', 'form', 'button', 'iframe', 'canvas',
  'object', 'template', 'aside', 'input', 'select', 'textarea', 'map',
])
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])
const BREAK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'td', 'th', 'section', 'article', 'figure', 'figcaption',
  'blockquote', 'ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'dt', 'dd', 'br', 'pre', 'main', 'aside', 'nav', 'header', 'footer',
])

function findTagEnd(html, from) {
  let quote = ''
  for (let index = from; index < html.length; index += 1) {
    const char = html[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '>') return index
  }
  return -1
}

function parseAttributes(raw) {
  const attrs = Object.create(null)
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = re.exec(raw)) !== null) {
    if (match[1] === '') continue
    const name = match[1].toLowerCase()
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

function parseHtml(html) {
  const root = { tag: '#root', attrs: Object.create(null), children: [] }
  const stack = [root]
  let index = 0
  const length = html.length
  while (index < length) {
    const lt = html.indexOf('<', index)
    if (lt === -1) {
      appendText(stack[stack.length - 1], html.slice(index))
      break
    }
    if (lt > index) appendText(stack[stack.length - 1], html.slice(index, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      index = end === -1 ? length : end + 3
      continue
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9)
      if (end !== -1) appendText(stack[stack.length - 1], html.slice(lt + 9, end))
      index = end === -1 ? length : end + 3
      continue
    }
    const next = html[lt + 1] ?? ''
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt + 2)
      index = end === -1 ? length : end + 1
      continue
    }
    if (next === '/') {
      const end = html.indexOf('>', lt + 2)
      if (end === -1) break
      const name = html.slice(lt + 2, end).trim().split(/\s+/)[0].toLowerCase()
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === name) {
          stack.length = depth
          break
        }
      }
      index = end + 1
      continue
    }
    const end = findTagEnd(html, lt + 1)
    if (end === -1) {
      appendText(stack[stack.length - 1], html.slice(lt))
      break
    }
    let inner = html.slice(lt + 1, end)
    let selfClosing = false
    if (inner.trimEnd().endsWith('/')) {
      selfClosing = true
      inner = inner.trimEnd().slice(0, -1)
    }
    const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(inner)
    if (nameMatch === null) {
      index = end + 1
      continue
    }
    const tag = nameMatch[1].toLowerCase()
    const attrs = parseAttributes(inner.slice(nameMatch[1].length))
    index = end + 1
    if (RAW_TEXT_TAGS.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
      const rest = html.slice(index)
      const closeMatch = closeRe.exec(rest)
      index = closeMatch === null ? length : index + closeMatch.index + closeMatch[0].length
      continue
    }
    const node = { tag, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(node)
  }
  return root
}

function appendText(parent, raw) {
  if (raw === '') return
  parent.children.push(decodeEntities(raw))
}

function findAll(node, tag, out = []) {
  if (typeof node === 'string') return out
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (child.tag === tag) out.push(child)
    findAll(child, tag, out)
  }
  return out
}

function findFirst(node, predicate) {
  if (typeof node === 'string') return null
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (predicate(child)) return child
    const found = findFirst(child, predicate)
    if (found !== null) return found
  }
  return null
}

function rawText(node) {
  let out = ''
  const visit = (current) => {
    if (typeof current === 'string') {
      out += current
      return
    }
    for (const child of current.children) visit(child)
  }
  visit(node)
  return out.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Inline text and math
// ---------------------------------------------------------------------------

function mathLatex(node) {
  const alt = node.attrs?.alttext
  if (typeof alt === 'string' && alt.trim() !== '') return alt.trim()
  const annotation = findFirst(node, (child) => child.tag === 'annotation'
    && /x-tex/i.test(child.attrs?.encoding ?? ''))
  if (annotation !== null) {
    const tex = rawText(annotation)
    if (tex !== '') return tex
  }
  return rawText(node)
}

function inlineText(node) {
  let out = ''
  const visit = (current) => {
    if (typeof current === 'string') {
      out += current
      return
    }
    if (SKIP_TAGS.has(current.tag)) return
    if (current.tag === 'math') {
      const latex = mathLatex(current)
      if (latex !== '') out += ` $${latex}$ `
      return
    }
    if (current.tag === 'img' || current.tag === 'svg') return
    if (current.tag === 'br') {
      out += ' '
      return
    }
    const breaks = BREAK_TAGS.has(current.tag)
    if (breaks) out += ' '
    for (const child of current.children) visit(child)
    if (breaks) out += ' '
  }
  visit(node)
  return normalizeText(out)
}

function stripListMarker(text, ordered) {
  if (ordered) return text.replace(/^\d+[.)]\s+/, '')
  return text.replace(/^[•·▪◦‣●○]\s+/, '')
}

// ---------------------------------------------------------------------------
// Structured extraction
// ---------------------------------------------------------------------------

const REFERENCES_HEADING_RE = /^(?:[0-9]+(?:\.[0-9]+)*[.)]?\s*|[IVXLC]+[.)]?\s*)?(?:references|bibliography|works cited)\b/i

function isReferencesNode(node) {
  const id = (node.attrs?.id ?? '').toLowerCase()
  const className = (node.attrs?.class ?? '').toLowerCase()
  return id === 'bib' || id === 'references' || className.includes('ltx_bibliography')
}

function isEquationTable(node) {
  const className = (node.attrs?.class ?? '').toLowerCase()
  if (className.includes('ltx_equation') || className.includes('ltx_eqn_table')) return true
  return findFirst(node, (child) => child.tag === 'tr'
    && (child.attrs?.class ?? '').toLowerCase().includes('ltx_equation')) !== null
}

function isDisplayMath(node) {
  const display = (node.attrs?.display ?? '').toLowerCase()
  return display === 'block' || display === 'true'
}

function resolveImageUrl(node, baseUrl) {
  let src = node.attrs?.src ?? node.attrs?.['data-src'] ?? ''
  if (src === '') {
    const srcset = node.attrs?.srcset ?? ''
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? ''
    src = first
  }
  if (src === '' || /^data:/i.test(src)) return null
  try {
    const url = new URL(src, baseUrl === '' ? undefined : baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

function isFigureImage(node) {
  if (node.tag !== 'img') return false
  const className = (node.attrs?.class ?? '').toLowerCase()
  if (className.includes('ltx_graphics')) return true
  const width = Number(node.attrs?.width)
  const height = Number(node.attrs?.height)
  return (Number.isFinite(width) && width >= 100) || (Number.isFinite(height) && height >= 100)
}

/** @returns {{ blocks: object[], sections: {level:number,title:string}[] }} */
export function extractStructuredDocument(html, { baseUrl = '' } = {}) {
  if (typeof html !== 'string' || html === '') return { blocks: [], sections: [] }
  const root = parseHtml(html)
  const blocks = []
  const sections = []
  let stopped = false

  function emitImage(node, caption) {
    if (stopped) return
    if (!isFigureImage(node)) return
    const src = resolveImageUrl(node, baseUrl)
    if (src === null) return
    blocks.push({ type: 'figure', src, caption: caption === '' ? null : caption })
  }

  function captionOf(node) {
    const caption = findFirst(node, (child) => child.tag === 'figcaption')
    return caption === null ? null : (inlineText(caption) || null)
  }

  function emitTable(node, caption) {
    const rows = []
    let firstRowHasHeader = false
    for (const row of findAll(node, 'tr')) {
      const cells = row.children.filter((child) => typeof child !== 'string'
        && (child.tag === 'td' || child.tag === 'th'))
      if (cells.length === 0) continue
      if (rows.length === 0 && cells.some((cell) => cell.tag === 'th')) firstRowHasHeader = true
      rows.push(cells.map((cell) => inlineText(cell)))
    }
    if (rows.length === 0) return
    const hasThead = findAll(node, 'thead').length > 0
    blocks.push({
      type: 'table',
      header: hasThead || firstRowHasHeader,
      caption: caption,
      rows,
    })
  }

  function emitEquations(node) {
    const rows = findAll(node, 'tr')
    const scopes = rows.length > 0 ? rows : [node]
    let emitted = false
    for (const scope of scopes) {
      const latex = findAll(scope, 'math')
        .map((math) => mathLatex(math))
        .filter((value) => value !== '')
        .join(' ')
      if (latex === '') continue
      blocks.push({ type: 'equation', latex, display: true })
      emitted = true
    }
    if (!emitted) {
      const text = inlineText(node)
      if (text !== '') blocks.push({ type: 'equation', latex: text, display: true })
    }
  }

  function emitFigure(node) {
    const className = (node.attrs?.class ?? '').toLowerCase()
    const caption = captionOf(node)
    const images = findAll(node, 'img')
    if (className.includes('ltx_table') || (images.length === 0 && findFirst(node, (child) => child.tag === 'table') !== null)) {
      const table = findFirst(node, (child) => child.tag === 'table')
      if (table !== null) emitTable(table, caption)
      return
    }
    if (images.length === 0) return
    let emitted = 0
    for (const image of images) {
      const src = resolveImageUrl(image, baseUrl)
      if (src === null) continue
      blocks.push({ type: 'figure', src, caption: emitted === 0 ? caption : null })
      emitted += 1
      if (emitted >= 8) break
    }
  }

  function emitList(node, ordered) {
    const direct = node.children.filter((child) => typeof child !== 'string' && child.tag === 'li')
    const items = direct.length > 0 ? direct : findAll(node, 'li')
    const texts = []
    for (const item of items) {
      const text = stripListMarker(inlineText(item), ordered)
      if (text !== '') texts.push(text)
    }
    if (texts.length === 0) return
    blocks.push({ type: 'list', ordered, items: texts })
  }

  function emitParagraph(node) {
    const text = inlineText(node)
    if (text !== '') blocks.push({ type: 'paragraph', text })
    for (const image of findAll(node, 'img')) emitImage(image, null)
  }

  function visit(node) {
    if (stopped || typeof node === 'string') return
    const tag = node.tag
    if (SKIP_TAGS.has(tag)) return
    if (isReferencesNode(node)) {
      stopped = true
      return
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = inlineText(node)
      if (text === '') return
      if (REFERENCES_HEADING_RE.test(text)) {
        stopped = true
        return
      }
      const rawLevel = Number(tag.slice(1))
      const level = Number.isFinite(rawLevel) ? Math.min(4, Math.max(1, rawLevel)) : 1
      blocks.push({ type: 'heading', level, text })
      sections.push({ level, title: text })
      return
    }
    if (tag === 'p') {
      emitParagraph(node)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      emitList(node, tag === 'ol')
      return
    }
    if (tag === 'blockquote') {
      const text = inlineText(node)
      if (text !== '') blocks.push({ type: 'quote', text })
      return
    }
    if (tag === 'figure') {
      emitFigure(node)
      return
    }
    if (tag === 'table') {
      if (isEquationTable(node)) emitEquations(node)
      else emitTable(node, null)
      return
    }
    if (tag === 'math') {
      if (isDisplayMath(node)) {
        const latex = mathLatex(node)
        if (latex !== '') blocks.push({ type: 'equation', latex, display: true })
      }
      return
    }
    if (tag === 'img') {
      emitImage(node, null)
      return
    }
    if ((tag === 'div' || tag === 'section') && (node.attrs?.class ?? '').toLowerCase().includes('ltx_equation')) {
      emitEquations(node)
      return
    }
    for (const child of node.children) visit(child)
  }

  visit(root)
  return {
    blocks: blocks.slice(0, MAX_BLOCKS),
    sections,
  }
}

/** Abstract-only fallback document (heading + abstract paragraph). */
export function abstractDocument(meta) {
  const baseId = typeof meta?.baseId === 'string' ? meta.baseId : ''
  const id = typeof meta?.id === 'string' && meta.id !== '' ? meta.id : (baseId || 'unknown')
  const title = typeof meta?.title === 'string' && meta.title.trim() !== ''
    ? normalizeText(meta.title)
    : 'arXiv paper'
  const abstract = typeof meta?.abstract === 'string' ? normalizeText(meta.abstract) : ''
  return {
    id,
    source: 'abstract',
    sections: [{ level: 1, title }],
    blocks: [
      { type: 'heading', level: 1, text: title },
      { type: 'paragraph', text: abstract !== '' ? abstract : '(abstract unavailable)' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Network fetch (ar5iv first, arxiv.org/html fallback, abstract last)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function fetchHtml(url, timeoutMs, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, Math.max(500, timeoutMs))
  const onAbort = () => { controller.abort() }
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: FETCH_HEADERS,
    })
    const text = await response.text()
    return { status: response.status, text }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function idPath(baseId) {
  return String(baseId).split('/').map((part) => encodeURIComponent(part)).join('/')
}

/**
 * Fetch and structure one paper. Network/extraction failures degrade to an
 * abstract-only document; only caller aborts propagate.
 * @param {{ id?: string, baseId?: string, title?: string, abstract?: string }} meta
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ id: string, source: 'ar5iv'|'arxiv-html'|'abstract', sections: object[], blocks: object[] }>}
 */
export async function fetchPaperDocument(meta, { timeoutMs = 20000, signal } = {}) {
  const baseId = typeof meta?.baseId === 'string' ? meta.baseId : ''
  if (baseId === '') return abstractDocument(meta)
  const id = typeof meta?.id === 'string' && meta.id !== '' ? meta.id : baseId
  const deadline = Date.now() + Math.max(2000, Number(timeoutMs) || 20000)
  const path = idPath(baseId)
  const candidates = [
    { source: 'ar5iv', url: `${AR5IV_ROOT}${path}/`, baseUrl: `${AR5IV_ROOT}${path}/` },
    { source: 'arxiv-html', url: `${ARXIV_HTML_ROOT}${path}/`, baseUrl: `${ARXIV_HTML_ROOT}${path}/` },
  ]

  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - Date.now()
      if (remaining < 1200) break
      try {
        const response = await fetchHtml(candidate.url, Math.min(attempt === 0 ? 10000 : 8000, remaining), signal)
        if (response.status === 200) {
          if (response.text.length <= MAX_HTML_CHARS) {
            const extracted = extractStructuredDocument(response.text, { baseUrl: candidate.baseUrl })
            if (extracted.blocks.length > 0) {
              return {
                id,
                source: candidate.source,
                sections: extracted.sections,
                blocks: extracted.blocks.slice(0, MAX_BLOCKS),
              }
            }
          }
          break
        }
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await sleep(1500)
          continue
        }
        break
      } catch (error) {
        if (signal?.aborted) throw error
        if (attempt === 0) {
          await sleep(1500)
          continue
        }
        break
      }
    }
  }
  return abstractDocument(meta)
}
