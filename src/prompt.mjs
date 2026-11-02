// Prompt construction for dsh-arxiv. No imports on purpose: the host bundles this
// module as-is and wants zero runtime dependencies.

/** Characters of paper text handed to the model for a summary. */
export const SUMMARY_TEXT_BUDGET = 40000
/** Characters of paper text handed to the model for a Q&A turn. */
export const QA_TEXT_BUDGET = 55000

const QA_MAX_TOKENS = 2600
const SUMMARY_MAX_TOKENS = 3200
const TEMPERATURE = 0.3
const MAX_HISTORY_MESSAGES = 6
const MAX_HISTORY_CHARS = 6000
const MAX_AUTHORS = 40

/** System prompt for the one-shot paper summary. Section list is contractual. */
export const SUMMARY_SYSTEM = `你是一名资深科研助理，擅长把 arXiv 论文提炼成信息密度高的中文速读笔记。

输出要求：
- 只输出 Markdown，不要任何前言、解释或结语。
- 严格按以下小节顺序输出，小节标题逐字使用：
## 一句话总结
## 核心贡献
## 方法
## 实验与结果
## 局限性
## 谁该读
- 「一句话总结」用一到两句说明论文解决的问题、采用的方法与主要结论。
- 「核心贡献」用 3–5 条无序列表，每条一句话。
- 「方法」说明关键思路与必要的技术细节（如模型结构、训练目标、算法步骤）。
- 「实验与结果」给出数据集、基线、主要指标和关键数字，只写论文中真实存在的结果。
- 「局限性」写论文明确承认或从实验设置可以推断出的限制；没有则写「论文未明确讨论」。
- 「谁该读」用一句话说明适合的读者与阅读重点。
- 全文不超过 600 个汉字，不要复述摘要原文，不要编造论文中不存在的数据或结论。
- 数学公式用 $…$（行内）或 $$…$$（块级）。`

/** System prompt for follow-up paper Q&A. */
export const QA_SYSTEM = `你是一名严谨的论文问答助手，只依据用户提供的论文内容作答。

规则：
- 用提问所用的语言回答。
- 答案只能来自提供的论文正文；论文没有提到的内容不要臆测，要明确说明「论文没有找到相关说明」，并给出可以继续查找的线索（例如值得关注的章节或关键词）。
- 尽量标注答案依据的章节名，例如「（见 3.2 节 Attention）」。
- 先给结论，再给必要细节；保持简洁，不要复述与问题无关的论文内容。
- 数学用 $…$（行内）或 $$…$$（块级），符号与论文保持一致。`

function textOf(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function listOf(value) {
  if (!Array.isArray(value)) return []
  return value.map(textOf).filter(Boolean)
}

/** One normalized metadata block, emitted exactly once per user message. */
function formatMeta(meta) {
  const source = meta && typeof meta === 'object' ? meta : {}
  const lines = ['# 论文信息']

  const title = textOf(source.title)
  lines.push(`题名：${title || '（未知标题）'}`)

  const authors = listOf(source.authors)
  if (authors.length) lines.push(`作者：${authors.slice(0, MAX_AUTHORS).join(', ')}`)

  const id = textOf(source.baseId) || textOf(source.id)
  if (id) lines.push(`arXiv：${id}`)

  const published = textOf(source.published)
  const updated = textOf(source.updated)
  if (published) lines.push(`发布：${published}`)
  if (updated && updated !== published) lines.push(`更新：${updated}`)

  const primaryCategory = textOf(source.primaryCategory)
  const categories = listOf(source.categories)
  const categoryText = categories.length
    ? categories.join(', ')
    : primaryCategory
  if (categoryText) lines.push(`分类：${categoryText}`)

  const comment = textOf(source.comment)
  if (comment) lines.push(`备注：${comment}`)
  const journalRef = textOf(source.journalRef)
  if (journalRef) lines.push(`期刊：${journalRef}`)

  return lines.join('\n')
}

function abstractOf(meta) {
  return meta && typeof meta === 'object' && typeof meta.abstract === 'string'
    ? meta.abstract.trim()
    : ''
}

/** Drop a leading `## <title>` line that duplicates the metadata block. */
function stripLeadingTitle(text, meta) {
  const body = typeof text === 'string' ? text : ''
  if (!body) return ''
  const title = textOf(meta && meta.title)
  if (!title) return body
  const newline = body.indexOf('\n')
  const firstLine = newline === -1 ? body : body.slice(0, newline)
  if (!firstLine.startsWith('## ')) return body
  const heading = textOf(firstLine.slice(3))
  if (heading.toLowerCase() !== title.toLowerCase()) return body
  return newline === -1 ? '' : body.slice(newline + 1).trimStart()
}

function preparePaperText(text, meta, budget) {
  const source = typeof text === 'string' && text.trim() ? text : abstractOf(meta)
  return trimPaperText(stripLeadingTitle(source, meta), budget)
}

function paperSection(meta, text, fullText, budget) {
  const abstractOnly = fullText === false
  const body = abstractOnly ? abstractOf(meta) : preparePaperText(text, meta, budget)
  return [
    abstractOnly ? '## 摘要（abstract）' : '## 论文正文',
    body || '（论文内容不可用）',
  ].join('\n')
}

/**
 * Trim paper text to a character budget, keeping the head and sampling section
 * boundaries that follow. Always returns at most `budget` characters.
 * @param {unknown} text
 * @param {number} budget
 * @returns {string}
 */
export function trimPaperText(text, budget) {
  const source = typeof text === 'string' ? text : (text == null ? '' : String(text))
  const numericBudget = Number(budget)
  const limit = Number.isFinite(numericBudget) && numericBudget > 0
    ? Math.floor(numericBudget)
    : SUMMARY_TEXT_BUDGET
  if (!source || limit <= 0) return ''
  if (source.length <= limit) return source

  // Without section headings there is nothing to sample: keep the head only.
  if (source.indexOf('\n## ') === -1) {
    let end = limit
    const lastCode = source.charCodeAt(end - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1
    return source.slice(0, end)
  }

  // Keep a generous head chunk (60% of the budget), then append complete later
  // sections while they fit so the model still sees how the paper ends.
  const headLength = Math.max(1, Math.floor(limit * 0.6))
  let headEnd = headLength
  const lastCode = source.charCodeAt(headEnd - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) headEnd -= 1 // do not split a surrogate pair

  let output = source.slice(0, headEnd).replace(/\s+$/, '')
  let cursor = headEnd
  while (output.length < limit) {
    const nextHeading = source.indexOf('\n## ', cursor)
    if (nextHeading === -1) break
    const following = source.indexOf('\n## ', nextHeading + 1)
    const sectionEnd = following === -1 ? source.length : following
    const chunk = source.slice(nextHeading, sectionEnd)
    const room = limit - output.length
    if (chunk.length <= room) {
      output += chunk
      cursor = sectionEnd
    } else {
      if (room > 120) {
        // Keep a truncated section start rather than stopping mid-sentence earlier.
        const partial = chunk.slice(0, room).replace(/\s+\S*$/, '')
        output += partial
      }
      break
    }
  }

  return output.length > limit ? output.slice(0, limit) : output
}

function userMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  }
}

/**
 * Build the summary prompt: metadata + paper text (fixed prefix) + task.
 * @param {{ meta?: object, text?: string, fullText?: boolean }} params
 */
export function buildSummaryMessages({ meta, text, fullText } = {}) {
  const parts = [
    formatMeta(meta),
    '',
    paperSection(meta, text, fullText, SUMMARY_TEXT_BUDGET),
    '',
    '## 任务',
    '请通读以上论文，按系统要求的 6 个小节输出中文速读笔记，总长不超过 600 个汉字；每个小节的标题必须逐字使用规定标题。',
  ]

  return {
    system: SUMMARY_SYSTEM,
    messages: [userMessage(parts.join('\n'))],
    maxTokens: SUMMARY_MAX_TOKENS,
    temperature: TEMPERATURE,
  }
}

/** Cap Q&A history at 6 messages / 6000 chars, preserving the newest turns. */
function renderHistory(history) {
  if (!Array.isArray(history) || !history.length) return ''
  const cleaned = history
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
    .map((entry) => ({ role: entry.role, content: typeof entry.content === 'string' ? entry.content.trim() : '' }))
    .filter((entry) => entry.content)

  let capped = cleaned.slice(-MAX_HISTORY_MESSAGES)
  let total = capped.reduce((sum, entry) => sum + entry.content.length, 0)
  while (capped.length > 1 && total > MAX_HISTORY_CHARS) {
    total -= capped[0].content.length
    capped = capped.slice(1)
  }
  if (capped.length && total > MAX_HISTORY_CHARS) {
    capped[0] = { ...capped[0], content: capped[0].content.slice(0, MAX_HISTORY_CHARS) }
  }

  const lines = ['Previous Q&A:']
  for (const entry of capped) {
    lines.push(`${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
  }
  return lines.join('\n')
}

/**
 * Build a Q&A prompt: metadata + paper text (identical prefix to the summary
 * prompt) + capped history + the current question at the end.
 * @param {{ meta?: object, text?: string, fullText?: boolean, question?: string, history?: Array<{role:string,content:string}> }} params
 */
export function buildQaMessages({ meta, text, fullText, question, history } = {}) {
  const parts = [
    formatMeta(meta),
    '',
    paperSection(meta, text, fullText, QA_TEXT_BUDGET),
  ]

  const historyBlock = renderHistory(history)
  if (historyBlock) {
    parts.push('', '## 先前问答', historyBlock)
  }

  const questionText = typeof question === 'string' ? question.trim() : ''
  parts.push('', '## 当前问题', `Question: ${questionText}`)

  return {
    system: QA_SYSTEM,
    messages: [userMessage(parts.join('\n'))],
    maxTokens: QA_MAX_TOKENS,
    temperature: TEMPERATURE,
  }
}
