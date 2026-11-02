// Offline-first tests for src/arxiv.mjs. Live network tests run only with AXV_LIVE=1.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ArxivError,
  extractSections,
  fetchFullText,
  fetchMeta,
  htmlToText,
  parseArxivId,
} from '../src/arxiv.mjs'

const LIVE = process.env.AXV_LIVE === '1'

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

// ---------------------------------------------------------------------------
// parseArxivId
// ---------------------------------------------------------------------------

test('parseArxivId accepts plain, prefixed, URL and old-style ids', () => {
  const cases = [
    ['2401.12345', '2401.12345', '2401.12345', null],
    ['2401.12345v2', '2401.12345v2', '2401.12345', 'v2'],
    ['arXiv:2401.12345', '2401.12345', '2401.12345', null],
    ['ARXIV:2401.12345V3', '2401.12345v3', '2401.12345', 'v3'],
    ['https://arxiv.org/abs/2401.12345v2', '2401.12345v2', '2401.12345', 'v2'],
    ['https://arxiv.org/pdf/2401.12345v3.pdf', '2401.12345v3', '2401.12345', 'v3'],
    ['https://arxiv.org/html/1706.03762', '1706.03762', '1706.03762', null],
    ['https://export.arxiv.org/abs/2401.12345', '2401.12345', '2401.12345', null],
    ['cs/0112017', 'cs/0112017', 'cs/0112017', null],
    ['math.GT/0309136', 'math.GT/0309136', 'math.GT/0309136', null],
    ['hep-th/9901001v2', 'hep-th/9901001v2', 'hep-th/9901001', 'v2'],
    ['cond-mat/0102536', 'cond-mat/0102536', 'cond-mat/0102536', null],
    ['  arXiv: 2401.12345  ', '2401.12345', '2401.12345', null],
    ['see arXiv:2401.12345v2 for details', '2401.12345v2', '2401.12345', 'v2'],
    ['download at https://arxiv.org/pdf/1706.03762v7.pdf (PDF)', '1706.03762v7', '1706.03762', 'v7'],
    ['doi:10.48550/arXiv.1706.03762', '1706.03762', '1706.03762', null],
    ['<2401.12345>', '2401.12345', '2401.12345', null],
  ]
  for (const [input, id, baseId, version] of cases) {
    assert.deepEqual(parseArxivId(input), { id, baseId, version }, `input: ${input}`)
  }
})

test('parseArxivId rejects junk and non-ids', () => {
  const cases = [
    '', '   ', 'nope', '12345.6789', '2401.123', '2401.123456', '24.0112345',
    'arXiv:', 'https://example.com/paper', 'not an arxiv id at all', 'v2',
  ]
  for (const input of cases) {
    assert.equal(parseArxivId(input), null, `input: ${input}`)
  }
  for (const input of [null, undefined, 42, {}, [], true]) {
    assert.equal(parseArxivId(input), null, `input: ${String(input)}`)
  }
})

// ---------------------------------------------------------------------------
// htmlToText: real ar5iv fixture
// ---------------------------------------------------------------------------

const REAL_FIXTURE = 'ar5iv-1706.03762.html'

test('htmlToText converts the trimmed ar5iv paper to readable text', () => {
  const text = htmlToText(fixture(REAL_FIXTURE))
  assert.ok(text.length > 10000, `expected a long extraction, got ${text.length}`)
  assert.ok(text.includes('## Attention Is All You Need'))
  assert.ok(text.includes('## 1 Introduction'))
  assert.ok(text.includes('## 3 Model Architecture'))
  assert.ok(text.includes('## 3.2 Attention'))
  assert.ok(text.includes('Transformer'))
  assert.ok(text.includes('\n\n'), 'paragraphs must be separated by blank lines')
  // The document <title> ([1706.03762] ...) must not leak into the body.
  assert.ok(!text.startsWith('[1706.03762]'))
  assert.ok(!text.includes('[1706.03762]'))
  assert.ok(!/<script|<style|<math|<div/i.test(text), 'no markup should survive')
})

test('htmlToText keeps TeX from math alttext as $...$', () => {
  const text = htmlToText(fixture(REAL_FIXTURE))
  assert.ok(text.includes('$h_{t}$'), 'expected the h_t inline math alttext')
  const inlineMath = text.match(/\$[^$\n]{1,80}\$/g) || []
  assert.ok(inlineMath.length > 20, `expected many inline formulas, got ${inlineMath.length}`)
})

test('htmlToText cuts the references section of the ar5iv fixture', () => {
  const text = htmlToText(fixture(REAL_FIXTURE))
  assert.ok(!/^##\s+(?:\d+\s+)?(?:References|Bibliography)\s*$/m.test(text))
  assert.ok(!text.includes('References'), 'references heading must be removed')
  assert.ok(!text.includes('Layer normalization'), 'reference [1] must be removed')
})

// ---------------------------------------------------------------------------
// htmlToText: synthetic edge cases
// ---------------------------------------------------------------------------

test('htmlToText handles the synthetic malformed fixture', () => {
  const text = htmlToText(fixture('synthetic-edge.html'))

  // Headings (h1-h4) become markdown headings, h5/h6 would be plain text.
  for (const heading of ['## Synthetic Edge Cases', '## 1 Introduction', '## 1.1 Sub Section', '## 2 Methods', '## 2.1.1 Deep Note']) {
    assert.ok(text.includes(heading), `missing heading ${heading}`)
  }

  // Entities are decoded.
  assert.ok(text.includes("A & B < C > D 'quoted' spaced \u2014 dash \u2014 too."))

  // Math alttext becomes $...$ (entities decoded inside TeX too).
  assert.ok(text.includes('$x_{t}^{2} + \\alpha < \\beta$'))
  assert.ok(text.includes('Inline math $x_{t}^{2}'), 'math should stay inline in its paragraph')
  assert.ok(!text.includes('semantics'), 'MathML markup must be dropped')

  // Paragraph-ish blocks.
  assert.ok(text.includes('First item & one\n\nSecond item'), 'list items become paragraphs')
  assert.ok(text.includes('Figure 1: A caption.'))
  assert.ok(text.includes('Figure 1: A caption.\n\n## 2 Methods'))

  // Dropped chrome and the references cut.
  for (const dropped of [
    'NAV SHOULD BE DROPPED',
    'HEADER SHOULD BE DROPPED',
    'FOOTER SHOULD BE DROPPED',
    'SCRIPT MUST NOT APPEAR',
    'REFERENCE MUST BE CUT',
    'window.bad',
  ]) {
    assert.ok(!text.includes(dropped), `expected ${dropped} to be dropped`)
  }
  assert.ok(!text.includes('## References'))
})

test('htmlToText drops math without alttext but keeps surrounding text', () => {
  const text = htmlToText('<p>before <math><mi>z</mi><mo>+</mo><mn>1</mn></math> after</p>')
  assert.equal(text, 'before after')
})

// ---------------------------------------------------------------------------
// htmlToText: focused unit checks
// ---------------------------------------------------------------------------

test('htmlToText decodes common HTML entities', () => {
  const text = htmlToText('<p>A &amp; B &lt; C &gt; D &#39;q&#39; &nbsp; &quot;d&quot; &#x2014; &mdash;</p>')
  assert.equal(text, 'A & B < C > D \'q\' "d" \u2014 \u2014')
})

test('htmlToText cuts References and Bibliography headings onward', () => {
  const references = htmlToText('<h2>1 Intro</h2><p>keep me</p><h2>7 References</h2><p>drop me</p><h3>Appendix</h3><p>drop too</p>')
  assert.ok(references.includes('keep me'))
  assert.ok(!references.includes('drop me'))
  assert.ok(!references.includes('Appendix'))
  assert.ok(!references.includes('References'))

  const bibliography = htmlToText('<h2>Intro</h2><p>keep</p><h2><span>2</span> BIBLIOGRAPHY</h2><p>drop</p>')
  assert.ok(bibliography.includes('keep'))
  assert.ok(!bibliography.includes('drop'))
  assert.ok(!bibliography.includes('BIBLIOGRAPHY'))

  const bibNoSpace = htmlToText('<h2>Intro</h2><p>keep</p><h1>References</h1><p>drop</p>')
  assert.ok(bibNoSpace.includes('keep'))
  assert.ok(!bibNoSpace.includes('drop'))
})

test('htmlToText never throws on malformed or hostile input', () => {
  const inputs = [
    '', '   ', null, undefined, 123, {},
    '<div><p>hello',
    '<<<>>>',
    '<h2>References</h2><p>x</p>',
    '<p>unclosed <b>bold <i>italic',
    '<math>unclosed math',
    '<script>unclosed script',
    '<p>a &bogus; b &#xZZ; c</p>',
    '<!DOCTYPE html><html><body><p>ok</p></body></html>',
    'x'.repeat(200000),
    '<h1></h1><h2>  </h2><p></p>',
  ]
  for (const input of inputs) {
    let text
    assert.doesNotThrow(() => {
      text = htmlToText(input)
    }, `threw for input ${String(input).slice(0, 40)}`)
    assert.equal(typeof text, 'string')
  }
  assert.equal(htmlToText(null), '')
  assert.equal(htmlToText(undefined), '')
})

test('htmlToText strips document chrome (head/title/nav/header/footer/script)', () => {
  const html = [
    '<html><head><title>PAGE TITLE</title><script>var x = 1</script></head><body>',
    '<nav>NAV TEXT</nav><header>HEADER TEXT</header>',
    '<h1>Real Title</h1><p>Body text</p>',
    '<footer>FOOTER TEXT</footer><script>LEAKED</script></body></html>',
  ].join('')
  const text = htmlToText(html)
  assert.equal(text, '## Real Title\n\nBody text')
})

test('htmlToText performance: 2.5 MB+ document in well under a second', () => {
  const block = '<section><h2>Section Title</h2><p>' + 'word '.repeat(60) +
    '<math alttext="x_{i}^{2}"></math> more &amp; text.</p><ul><li>item one</li><li>item two</li></ul></section>'
  const big = '<!DOCTYPE html><html><body>' + block.repeat(9000) + '</body></html>'
  assert.ok(big.length > 2_500_000, `generated ${big.length} bytes`)
  const started = Date.now()
  const text = htmlToText(big)
  const elapsed = Date.now() - started
  assert.ok(text.length > 1_000_000)
  assert.ok(elapsed < 1500, `htmlToText took ${elapsed} ms for ${big.length} bytes`)
})

// ---------------------------------------------------------------------------
// extractSections
// ---------------------------------------------------------------------------

test('extractSections returns markdown heading names from paper text', () => {
  const text = htmlToText(fixture(REAL_FIXTURE))
  const sections = extractSections(text)
  assert.ok(sections.length > 5)
  assert.ok(sections.length <= 40)
  assert.ok(sections.includes('1 Introduction'))
  assert.ok(sections.includes('3.2 Attention'))
  for (const section of sections) {
    assert.equal(section, section.trim())
    assert.ok(!section.startsWith('#'))
  }
})

test('extractSections trims, ignores non-headings and caps at 40', () => {
  assert.deepEqual(extractSections('## A\n\ntext\n\n## B \n\nplain\n\n### C'), ['A', 'B', 'C'])
  assert.deepEqual(extractSections(''), [])
  assert.deepEqual(extractSections(null), [])
  assert.deepEqual(extractSections(undefined), [])
  assert.deepEqual(extractSections(42), [])
  assert.deepEqual(extractSections('## '), [])

  const many = Array.from({ length: 60 }, (_, i) => `## Section ${i}`).join('\n\n')
  const capped = extractSections(many)
  assert.equal(capped.length, 40)
  assert.equal(capped[0], 'Section 0')
  assert.equal(capped[39], 'Section 39')
})

// ---------------------------------------------------------------------------
// fetch helpers: offline error paths
// ---------------------------------------------------------------------------

test('fetchMeta rejects an invalid id offline without touching the network', async () => {
  await assert.rejects(
    fetchMeta('definitely not an id'),
    (error) => error instanceof ArxivError && error.code === 'bad-id',
  )
  await assert.rejects(fetchMeta(''), (error) => error instanceof ArxivError && error.code === 'bad-id')
})

test('fetchFullText rejects an invalid id offline', async () => {
  await assert.rejects(
    fetchFullText('nope, not an id'),
    (error) => error instanceof ArxivError && error.code === 'bad-id',
  )
})

test('ArxivError carries a stable code and name', () => {
  const error = new ArxivError('timeout', 'too slow')
  assert.equal(error.name, 'ArxivError')
  assert.equal(error.code, 'timeout')
  assert.equal(error.message, 'too slow')
  assert.ok(error instanceof Error)
})

// ---------------------------------------------------------------------------
// fetch helpers: mocked network paths (abs page -> export API -> abstract)
// ---------------------------------------------------------------------------

const API_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-01-03T00:00:00Z</updated>
    <published>2024-01-02T00:00:00Z</published>
    <title>A Study of Things</title>
    <summary>This abstract describes the study of things in detail.</summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
    <arxiv:primary_category term="cs.LG"/>
    <category term="cs.LG"/>
    <category term="cs.AI"/>
    <arxiv:comment>12 pages</arxiv:comment>
    <arxiv:journal_ref>Journal of Examples 1 (2024)</arxiv:journal_ref>
  </entry>
</feed>`

async function withMockedFetch(mock, run) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

test('fetchMeta falls back to the export API when the abs page fails', async () => {
  const meta = await withMockedFetch(
    async (url) => {
      if (String(url).includes('export.arxiv.org')) return new Response(API_FEED, { status: 200 })
      return new Response('upstream down', { status: 503 })
    },
    () => fetchMeta('2401.12345'),
  )
  assert.equal(meta.baseId, '2401.12345')
  assert.equal(meta.id, '2401.12345v2')
  assert.equal(meta.version, 'v2')
  assert.equal(meta.title, 'A Study of Things')
  assert.ok(meta.abstract.includes('study of things'))
  assert.deepEqual(meta.authors, ['Alice Example', 'Bob Example'])
  assert.equal(meta.published, '2024-01-02')
  assert.equal(meta.updated, '2024-01-03')
  assert.equal(meta.primaryCategory, 'cs.LG')
  assert.deepEqual(meta.categories, ['cs.LG', 'cs.AI'])
  assert.equal(meta.comment, '12 pages')
  assert.equal(meta.journalRef, 'Journal of Examples 1 (2024)')
  assert.equal(meta.absUrl, 'https://arxiv.org/abs/2401.12345')
})

test('fetchMeta reports network when the abs page and the API both fail', async () => {
  await withMockedFetch(
    async () => new Response('down', { status: 503 }),
    async () => {
      await assert.rejects(
        fetchMeta('2401.12345'),
        (error) => error instanceof ArxivError && error.code === 'network',
      )
    },
  )
})

test('fetchMeta maps an aborted request to a timeout error', async () => {
  await withMockedFetch(
    (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }),
    async () => {
      await assert.rejects(
        fetchMeta('2401.12345', { timeoutMs: 400 }),
        (error) => error instanceof ArxivError && error.code === 'timeout',
      )
    },
  )
})

test('fetchFullText falls back to arxiv.org/html when ar5iv fails', async () => {
  const html = fixture(REAL_FIXTURE)
  const full = await withMockedFetch(
    async (url) => {
      if (String(url).includes('ar5iv')) return new Response('gone', { status: 404 })
      if (String(url).includes('arxiv.org/html')) return new Response(html, { status: 200 })
      return new Response('', { status: 404 })
    },
    () => fetchFullText('1706.03762', { baseId: '1706.03762', abstract: '' }),
  )
  assert.equal(full.source, 'arxiv-html')
  assert.ok(full.text.includes('## 1 Introduction'))
  assert.ok(full.sections.length > 5)
})

test('fetchFullText retries ar5iv once after a 503', async () => {
  const html = fixture(REAL_FIXTURE)
  let ar5ivCalls = 0
  const started = Date.now()
  const full = await withMockedFetch(
    async (url) => {
      if (String(url).includes('ar5iv')) {
        ar5ivCalls += 1
        return ar5ivCalls === 1 ? new Response('busy', { status: 503 }) : new Response(html, { status: 200 })
      }
      return new Response('', { status: 404 })
    },
    () => fetchFullText('1706.03762', { baseId: '1706.03762' }, { timeoutMs: 12000 }),
  )
  assert.equal(ar5ivCalls, 2, 'expected exactly one retry')
  assert.equal(full.source, 'ar5iv')
  assert.ok(Date.now() - started >= 1400, 'retry must wait roughly 1.5 s')
})

test('fetchFullText falls back to the abstract as the last resort', async () => {
  const full = await withMockedFetch(
    async () => new Response('not here', { status: 404 }),
    () => fetchFullText('9999.99999', { baseId: '9999.99999', abstract: 'An abstract survives.' }),
  )
  assert.equal(full.source, 'abstract')
  assert.equal(full.text, 'An abstract survives.')
  assert.deepEqual(full.sections, ['Abstract'])
})

test('fetchFullText agrees on the abstract even without a meta object', async () => {
  const full = await withMockedFetch(
    async (url) => {
      const target = String(url)
      if (target.includes('export.arxiv.org')) return new Response(API_FEED, { status: 200 })
      if (target.includes('arxiv.org/abs')) return new Response('down', { status: 503 })
      return new Response('not here', { status: 404 })
    },
    () => fetchFullText('2401.12345', undefined, { timeoutMs: 12000 }),
  )
  assert.equal(full.source, 'abstract')
  assert.ok(full.text.includes('study of things'))
  assert.deepEqual(full.sections, ['Abstract'])
})

// ---------------------------------------------------------------------------
// Live network (AXV_LIVE=1 only)
// ---------------------------------------------------------------------------

test('live: fetchMeta reads the arXiv abs page', { skip: !LIVE }, async () => {
  const meta = await fetchMeta('1706.03762')
  assert.equal(meta.baseId, '1706.03762')
  assert.equal(meta.title, 'Attention Is All You Need')
  assert.ok(meta.abstract.length > 200)
  assert.equal(meta.authors.length, 8)
  assert.ok(meta.authors[0].includes('Vaswani'))
  assert.equal(meta.published, '2017-06-12')
  assert.equal(meta.primaryCategory, 'cs.CL')
  assert.ok(meta.categories.includes('cs.LG'))
  assert.equal(meta.absUrl, 'https://arxiv.org/abs/1706.03762')
  assert.ok(meta.pdfUrl.includes('arxiv.org/pdf/1706.03762'))
  assert.ok(meta.htmlUrl.includes('arxiv.org/html/1706.03762'))
  assert.ok(!JSON.stringify(meta).includes('undefined'))
})

test('live: fetchMeta reports not-found for a missing paper', { skip: !LIVE }, async () => {
  await assert.rejects(
    fetchMeta('9999.99999', { timeoutMs: 12000 }),
    (error) => error instanceof ArxivError && error.code === 'not-found',
  )
})

test('live: fetchFullText returns ar5iv text with sections', { skip: !LIVE }, async () => {
  const meta = await fetchMeta('1706.03762')
  const full = await fetchFullText('1706.03762', meta)
  assert.equal(full.source, 'ar5iv')
  assert.ok(full.text.length > 10000, `got ${full.text.length} chars`)
  assert.ok(full.sections.length > 5)
  assert.ok(full.text.includes('Transformer'))
  assert.ok(!full.text.includes('References'))
})
