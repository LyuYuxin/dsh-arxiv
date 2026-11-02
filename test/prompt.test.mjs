// Offline tests for src/prompt.mjs: budgets, section order, history caps, prefixes.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  QA_SYSTEM,
  QA_TEXT_BUDGET,
  SUMMARY_SYSTEM,
  SUMMARY_TEXT_BUDGET,
  buildQaMessages,
  buildSummaryMessages,
  trimPaperText,
} from '../src/prompt.mjs'

const META = {
  id: '2401.12345v2',
  baseId: '2401.12345',
  version: 'v2',
  title: 'A Study of Things',
  abstract: 'This abstract describes the study of things in detail.',
  authors: ['Alice Example', 'Bob Example'],
  published: '2024-01-02',
  updated: '2024-02-03',
  primaryCategory: 'cs.LG',
  categories: ['cs.LG', 'cs.AI'],
  comment: '12 pages',
  journalRef: 'Journal of Examples 1 (2024)',
  absUrl: 'https://arxiv.org/abs/2401.12345',
  pdfUrl: 'https://arxiv.org/pdf/2401.12345',
  htmlUrl: 'https://arxiv.org/html/2401.12345',
}

const PAPER_TEXT = [
  '## 1 Introduction',
  '',
  'This paper studies things. '.repeat(20),
  '',
  '## 2 Method',
  '',
  'We propose a method. '.repeat(30),
  '',
  '## 3 Results',
  '',
  'The results are good. '.repeat(30),
].join('\n')

const SUMMARY_HEADINGS = [
  '## 一句话总结',
  '## 核心贡献',
  '## 方法',
  '## 实验与结果',
  '## 局限性',
  '## 谁该读',
]

function userText(result) {
  return result.messages[0].content[0].text
}

// ---------------------------------------------------------------------------
// System prompts and budgets
// ---------------------------------------------------------------------------

test('SUMMARY_SYSTEM lists the six required sections in order', () => {
  assert.ok(typeof SUMMARY_SYSTEM === 'string' && SUMMARY_SYSTEM.length > 100)
  let previous = -1
  for (const heading of SUMMARY_HEADINGS) {
    const index = SUMMARY_SYSTEM.indexOf(heading)
    assert.ok(index > previous, `${heading} is missing or out of order`)
    previous = index
  }
  assert.ok(SUMMARY_SYSTEM.includes('600'), 'summary must ask for the 600 char budget')
})

test('QA_SYSTEM states the grounding and citation rules', () => {
  assert.ok(typeof QA_SYSTEM === 'string' && QA_SYSTEM.length > 100)
  assert.ok(QA_SYSTEM.includes('章节'), 'QA answers must cite section names')
  assert.ok(QA_SYSTEM.includes('论文'), 'QA must be grounded in the paper')
  assert.ok(QA_SYSTEM.includes('$'), 'QA must mention math markup')
})

test('text budgets match the contract', () => {
  assert.equal(SUMMARY_TEXT_BUDGET, 40000)
  assert.equal(QA_TEXT_BUDGET, 55000)
})

// ---------------------------------------------------------------------------
// buildSummaryMessages
// ---------------------------------------------------------------------------

test('buildSummaryMessages returns one user message with metadata and task', () => {
  const result = buildSummaryMessages({ meta: META, text: PAPER_TEXT, fullText: true })
  assert.equal(result.system, SUMMARY_SYSTEM)
  assert.equal(result.maxTokens, 3200)
  assert.equal(result.temperature, 0.3)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].role, 'user')
  assert.ok(Array.isArray(result.messages[0].content))
  assert.equal(result.messages[0].content.length, 1)
  assert.equal(result.messages[0].content[0].type, 'text')

  const text = userText(result)
  assert.ok(text.includes('A Study of Things'))
  assert.ok(text.includes('Alice Example, Bob Example'))
  assert.ok(text.includes('2024-01-02'))
  assert.ok(text.includes('cs.LG, cs.AI'))
  assert.ok(text.includes('## 论文正文'))
  assert.ok(text.includes('## 2 Method'))
  assert.ok(text.includes('## 任务'))
  assert.ok(text.includes('600'))
})

test('buildSummaryMessages includes metadata exactly once (dedupes the title heading)', () => {
  const text = '## A Study of Things\n\nBody of the paper.'
  const result = buildSummaryMessages({ meta: META, text, fullText: true })
  const user = userText(result)
  assert.equal((user.match(/A Study of Things/g) || []).length, 1)
  assert.ok(user.includes('Body of the paper.'))
})

test('buildSummaryMessages uses the abstract when fullText is false', () => {
  const result = buildSummaryMessages({ meta: META, text: 'FULL TEXT SENTINEL', fullText: false })
  const user = userText(result)
  assert.ok(user.includes(META.abstract))
  assert.ok(!user.includes('FULL TEXT SENTINEL'))
  assert.ok(user.includes('## 摘要（abstract）'))
  assert.ok(!user.includes('## 论文正文'))
})

test('buildSummaryMessages ignores an oversized body beyond the summary budget', () => {
  const huge = 'START ' + 'x'.repeat(SUMMARY_TEXT_BUDGET * 2) + ' END-MARKER'
  const user = userText(buildSummaryMessages({ meta: META, text: huge, fullText: true }))
  assert.ok(user.includes('START'))
  assert.ok(!user.includes('END-MARKER'))
  assert.ok(user.length < SUMMARY_TEXT_BUDGET + 4000, `user prompt too long: ${user.length}`)
})

test('buildSummaryMessages never emits the string "undefined"', () => {
  for (const params of [
    {},
    { meta: {} },
    { meta: { title: 'Only title' } },
    { meta: { title: 'T', abstract: 'A' }, text: '', fullText: true },
  ]) {
    const user = userText(buildSummaryMessages(params))
    assert.ok(!user.includes('undefined'), 'prompt must not contain undefined')
    assert.ok(!user.includes('null'))
    assert.ok(user.length > 0)
  }
})

// ---------------------------------------------------------------------------
// buildQaMessages
// ---------------------------------------------------------------------------

test('buildQaMessages puts the question after the fixed paper prefix', () => {
  const result = buildQaMessages({
    meta: META,
    text: PAPER_TEXT,
    fullText: true,
    question: 'What is the main method?',
    history: [],
  })
  assert.equal(result.system, QA_SYSTEM)
  assert.equal(result.maxTokens, 2600)
  assert.equal(result.temperature, 0.3)
  assert.equal(result.messages.length, 1)

  const user = userText(result)
  assert.ok(user.includes('## 论文正文'))
  assert.ok(user.includes('## 2 Method'))
  assert.ok(user.indexOf('## 2 Method') < user.indexOf('Question: What is the main method?'))
  assert.ok(user.trimEnd().endsWith('Question: What is the main method?'), 'question must be last')
})

test('buildQaMessages renders capped history as plain text in order', () => {
  const history = [
    { role: 'user', content: 'First question?' },
    { role: 'assistant', content: 'First answer.' },
    { role: 'user', content: 'Second question?' },
    { role: 'assistant', content: 'Second answer.' },
  ]
  const user = userText(buildQaMessages({ meta: META, text: PAPER_TEXT, fullText: true, question: 'Third question?', history }))

  assert.ok(user.includes('Previous Q&A:'))
  const first = user.indexOf('User: First question?')
  const second = user.indexOf('Assistant: First answer.')
  const third = user.indexOf('User: Second question?')
  const fourth = user.indexOf('Assistant: Second answer.')
  assert.ok(first > -1 && second > first && third > second && fourth > third)
  assert.ok(fourth < user.indexOf('Question: Third question?'))
})

test('buildQaMessages caps history at 6 messages and 6000 chars', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `MSG-${i} ` + 'y'.repeat(50),
  }))
  const user = userText(buildQaMessages({ meta: META, text: PAPER_TEXT, fullText: true, question: 'q?', history: many }))
  assert.equal((user.match(/MSG-\d+/g) || []).length, 6)
  assert.ok(user.includes('MSG-4'))
  assert.ok(user.includes('MSG-9'))
  assert.ok(!user.includes('MSG-0'))
  assert.ok(!user.includes('MSG-3'))

  const huge = [
    { role: 'user', content: 'A'.repeat(5000) },
    { role: 'assistant', content: 'B'.repeat(5000) },
  ]
  const hugeUser = userText(buildQaMessages({ meta: META, text: PAPER_TEXT, fullText: true, question: 'q?', history: huge }))
  const start = hugeUser.indexOf('Previous Q&A:')
  const end = hugeUser.indexOf('## 当前问题')
  assert.ok(start > -1 && end > start)
  assert.ok(end - start <= 6100, `history block is ${end - start} chars`)
})

test('buildQaMessages uses the abstract when fullText is false', () => {
  const user = userText(buildQaMessages({ meta: META, text: 'FULL TEXT SENTINEL', fullText: false, question: 'Q?', history: [] }))
  assert.ok(user.includes(META.abstract))
  assert.ok(!user.includes('FULL TEXT SENTINEL'))
  assert.ok(user.includes('## 摘要（abstract）'))
})

test('buildQaMessages tolerates missing meta/history/question', () => {
  for (const params of [
    {},
    { meta: {} },
    { meta: { title: 'T' }, question: '' },
    { meta: META, question: '   ' },
    { meta: META, history: [null, { role: 'system', content: 'x' }, { role: 'user', content: '' }] },
  ]) {
    const result = buildQaMessages(params)
    const user = userText(result)
    assert.ok(!user.includes('undefined'))
    assert.ok(user.endsWith('Question: ') || user.includes('Question:'))
  }
})

test('buildQaMessages shares the exact paper prefix across questions', () => {
  const first = userText(buildQaMessages({ meta: META, text: PAPER_TEXT, fullText: true, question: 'Question one?', history: [] }))
  const second = userText(buildQaMessages({ meta: META, text: PAPER_TEXT, fullText: true, question: 'Question two?', history: [] }))
  const marker = '## 当前问题'
  assert.equal(first.slice(0, first.indexOf(marker)), second.slice(0, second.indexOf(marker)))
})

// ---------------------------------------------------------------------------
// trimPaperText
// ---------------------------------------------------------------------------

test('trimPaperText keeps short text untouched', () => {
  assert.equal(trimPaperText('hello world', 100), 'hello world')
  assert.equal(trimPaperText('', 100), '')
  assert.equal(trimPaperText(null, 100), '')
  assert.equal(trimPaperText(undefined, 100), '')
})

test('trimPaperText returns at most the budget and keeps the head', () => {
  const source = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n` + 'lorem ipsum dolor sit amet '.repeat(6)).join('\n\n')
  const trimmed = trimPaperText(source, 800)
  assert.ok(trimmed.length <= 800, `got ${trimmed.length} chars`)
  assert.ok(trimmed.startsWith('## Section 0'))
  assert.ok(trimmed.includes('## Section 0'))
  assert.ok(source.startsWith(trimmed.slice(0, 50)))

  const tiny = trimPaperText('abcdefghij', 4)
  assert.equal(tiny.length, 4)
  assert.equal(tiny, 'abcd')
})

test('trimPaperText samples section boundaries beyond the head', () => {
  const source = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n` + 'content '.repeat(10)).join('\n\n')
  const trimmed = trimPaperText(source, 900)
  const numbers = [...trimmed.matchAll(/^## Section (\d+)/gm)].map((match) => Number(match[1]))
  assert.ok(numbers.length > 3, `expected several sections, got ${numbers.join(',')}`)
  assert.ok(Math.max(...numbers) >= 6, `expected later sections to be sampled, got max ${Math.max(...numbers)}`)
  assert.ok(trimmed.length <= 900)
})

test('trimPaperText falls back to the summary budget for a missing budget', () => {
  const source = 'x'.repeat(SUMMARY_TEXT_BUDGET + 1000)
  const trimmed = trimPaperText(source)
  assert.ok(trimmed.length <= SUMMARY_TEXT_BUDGET)
})
