// Markdown 感知切句器：把用户粘贴的英文技术文档拆成「跟读/回译」用的单句。
// 设计取舍（见 docs/superpowers/specs/2026-10-26-text-practice-design.md §4）：
//  - 只做确定性文本处理，零 AI、零网络；
//  - 术语保真优先：去 Markdown 语法但不改写内容（`top_k`、`U-Net`、`getUserById` 原样留下）；
//  - 代码块整块丢弃（不是朗读材料），行内代码去反引号但保留内容；
//  - 标题不当练习句，只作为「这段句子属于哪一节」的 section 标签；
//  - 缩写 / 小数 / 版本号 / 人名首字母 / 行内代码里的点号不切句。

const MAX_UNITS = 200
const MAX_CHARS = 180

// 句末点号前出现这些 token 时不是句子结束（一律小写带点比较）
const ABBREVIATIONS = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'fig.', 'figs.', 'eq.', 'eqs.', 'sec.', 'secs.',
  'tab.', 'ref.', 'refs.', 'al.', 'cf.', 'resp.', 'approx.', 'dr.', 'mr.', 'mrs.',
  'ms.', 'prof.', 'inc.', 'ltd.', 'co.', 'st.', 'no.', 'nos.', 'min.', 'max.', 'avg.',
])

/**
 * 去掉行内 Markdown 语法，保留可见文本与术语原文。
 * 图片整条丢弃（alt 文本通常不是句子）。
 * @param {string} input
 * @returns {string}
 */
function stripMarkdownInline(input) {
  let s = String(input ?? '')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 强调语法只在「词边界上成对出现」时去掉：
  // `x**2`（指数）、`__init__`（dunder）、`a * b`（乘号）都必须原样保留。
  s = s.replace(/(?<![\w*])\*\*(?!\s)([^*]+?)(?<!\s)\*\*(?![\w*])/g, '$1')
  s = s.replace(/(?<![\w~])~~(?!\s)([^~]+?)(?<!\s)~~(?![\w~])/g, '$1')
  s = s.replace(/(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])/g, '$1')
  // 单下划线强调只在词边界成对去掉；`top_k` / `__init__` 原样保留
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/`/g, '')
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 该点号是否属于「不是句末」的情况。
 * @param {string} text 已去掉行内代码原文的文本
 * @param {number} i 点号下标
 */
function isProtectedDot(text, i) {
  const before = text.slice(0, i)
  const after = text.slice(i + 1).trimStart()
  const prevChar = text[i - 1]
  const nextChar = after[0]

  // 小数 / 版本号 / 数字点号链
  if (prevChar && /\d/.test(prevChar) && nextChar && /\d/.test(nextChar)) return true

  const tokenMatch = before.match(/([A-Za-z][A-Za-z.]*|\d+)$/)
  const token = tokenMatch ? tokenMatch[1] : ''

  // 常见缩写
  if (token && ABBREVIATIONS.has(`${token}.`.toLowerCase())) return true
  // U.S. / Ph.D. / A.I. 形态
  if (/(?:[A-Za-z]\.){2,}$/.test(`${before}.`)) return true
  // 人名首字母：J. Smith
  if (/^[A-Z]$/.test(token)) return true
  // 后面紧跟小写单词 → 不可能是新句子
  if (nextChar && /[a-z]/.test(nextChar)) return true
  return false
}

const CLOSERS = '"\'”’)）]」』'

/**
 * 段落内按句切分。行内代码先替换为占位符，避免 `` `model.fit()` `` 被切断。
 * @param {string} paragraph
 * @returns {string[]}
 */
function splitEnglishSentences(paragraph) {
  const text = String(paragraph ?? '').trim()
  if (!text) return []

  const codes = []
  const guarded = text.replace(/`[^`]*`/g, (m) => {
    codes.push(m)
    return `\u0000${codes.length - 1}\u0000`
  })

  const pieces = []
  let start = 0
  for (let i = 0; i < guarded.length; i++) {
    if (!'.!?…'.includes(guarded[i])) continue
    // 吸收尾随的闭引号 / 括号（如 “done.”）
    let end = i + 1
    while (end < guarded.length && CLOSERS.includes(guarded[end])) end++
    const nextChar = guarded[end]
    // 点号后面紧贴非空白（3.5 / model.fit / v1.2）→ 不是句末
    if (nextChar !== undefined && !/\s/.test(nextChar)) continue
    if (isProtectedDot(guarded, i)) continue
    const piece = guarded.slice(start, end).trim()
    if (piece) pieces.push(piece)
    start = end
    i = end - 1
  }
  const rest = guarded.slice(start).trim()
  if (rest) pieces.push(rest)

  return pieces
    .map((s) => s.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]).trim())
    .filter(Boolean)
}

/**
 * 超长句就近切开：优先 `; ` → ` — ` → `, ` → 空格，保证跟读能在 30 秒内读完。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitLong(text, maxChars) {
  const value = String(text ?? '').trim()
  if (value.length <= maxChars) return value ? [value] : []
  for (const sep of ['; ', ' — ', ', ']) {
    const cut = value.lastIndexOf(sep, maxChars)
    if (cut > 0) {
      const head = value.slice(0, cut).trim()
      const tail = value.slice(cut + sep.length).trim()
      if (head.length >= 20 && tail) return [head, ...splitLong(tail, maxChars)]
    }
  }
  const space = value.lastIndexOf(' ', maxChars)
  const cutAt = space > 0 ? space : maxChars
  return [value.slice(0, cutAt).trim(), ...splitLong(value.slice(cutAt).trim(), maxChars)]
}

// 表格行的竖线分隔必须跳过行内代码里的 `|`（例如 | `a|b` | x |）
function splitTableCells(line) {
  const cells = []
  let buffer = ''
  let inCode = false
  for (const ch of String(line ?? '')) {
    if (ch === '`') { inCode = !inCode; buffer += ch; continue }
    if (ch === '|' && !inCode) { cells.push(buffer); buffer = ''; continue }
    buffer += ch
  }
  cells.push(buffer)
  return cells
}

const TABLE_SEPARATOR_RE = /^[\s|:-]+$/
const HORIZONTAL_RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const HEADING_RE = /^#{1,6}\s+/
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const QUOTE_RE = /^\s*>\s?/
const TABLE_ROW_RE = /^\s*\|/

/**
 * 把 Markdown 全文拆成练习句。
 * @param {string} input
 * @param {{ maxUnits?: number, maxChars?: number }} [opts]
 * @returns {{ units: Array<{ en: string, section: string }>, truncated: boolean }}
 */
function splitMarkdown(input, opts = {}) {
  const maxUnits = Number.isFinite(opts.maxUnits) && opts.maxUnits > 0 ? Math.floor(opts.maxUnits) : MAX_UNITS
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.floor(opts.maxChars) : MAX_CHARS

  let text = String(input ?? '')
  if (!text.trim()) return { units: [], truncated: false }

  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
  // 围栏代码块整块丢弃（含内容，``` 与 ~~~ 两种围栏），HTML 注释同理
  text = text
    .replace(/\n?```[\s\S]*?```/g, '\n')
    .replace(/\n?~~~[\s\S]*?~~~/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/\n{3,}/g, '\n\n')

  const raw = []
  let section = ''
  let buffer = []

  const flush = () => {
    const paragraph = buffer.join(' ').replace(/\s+/g, ' ').trim()
    buffer = []
    if (!paragraph) return
    for (const s of splitEnglishSentences(stripMarkdownInline(paragraph))) {
      raw.push({ en: s, section })
    }
  }

  const pushCells = (line) => {
    flush()
    for (const cell of splitTableCells(line)) {
      const clean = stripMarkdownInline(cell)
      if (!clean) continue
      for (const s of splitEnglishSentences(clean)) raw.push({ en: s, section })
    }
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (!trimmed) {
      flush()
      continue
    }

    if (HEADING_RE.test(trimmed)) {
      flush()
      section = stripMarkdownInline(trimmed.replace(HEADING_RE, ''))
      continue
    }

    if (HORIZONTAL_RULE_RE.test(trimmed)) {
      flush()
      continue
    }

    if (TABLE_SEPARATOR_RE.test(trimmed) && trimmed.includes('-')) {
      flush()
      continue
    }

    if (TABLE_ROW_RE.test(trimmed)) {
      pushCells(trimmed.replace(/^\s*\|/, '').replace(/\|\s*$/, ''))
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      flush()
      const item = line.replace(LIST_ITEM_RE, '')
      for (const s of splitEnglishSentences(stripMarkdownInline(item))) raw.push({ en: s, section })
      continue
    }

    if (QUOTE_RE.test(line)) {
      buffer.push(line.replace(QUOTE_RE, ''))
      continue
    }

    buffer.push(trimmed)
  }
  flush()

  const units = []
  for (const item of raw) {
    for (const piece of splitLong(item.en, maxChars)) {
      const clean = piece.replace(/\s+/g, ' ').trim()
      if (clean.length < 2 || !/[A-Za-z]/.test(clean)) continue
      units.push({ en: clean, section: item.section })
    }
  }

  const truncated = units.length > maxUnits
  return { units: units.slice(0, maxUnits), truncated }
}

module.exports = { splitMarkdown, splitEnglishSentences, stripMarkdownInline, MAX_UNITS, MAX_CHARS }
