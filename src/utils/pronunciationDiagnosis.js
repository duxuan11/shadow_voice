// 跟读发音诊断（层 1）：从 parseResult() 的产物推导
//   ① 连读缺失（link-missing，建议）
//   ② 失爆/吞音（stop-elision，中性提示——是美音常态，不是错）
//   ③ 词尾辅音丢失（coda-loss，错误）
//
// 纯函数：无网络、无时间、无随机，同输入同输出（便于单测与阈值回归）。
//
// ⚠️ 为什么不用引擎的 liaisonref：2026-11-26 spike 实测，该字段在 6 种调用条件下
//    （自然连读 / 人为断开 400ms·870ms / auto_rhythm 0·1·"1" / rhythm:1）恒为 0，
//    属于死字段。真正的可用信号是「词间间隙 + 边界音素得分 + 意群标志」，
//    实测同位置 get|out：间隙 0ms → 尾音素 95 分；480ms → 85；870ms → 77。
import { stripStress, toIPA, isConsonant, isVowel } from '../data/phoneIpa.js'
import { THRESHOLDS, STOP_CONSONANTS } from '../data/linkRules.js'

const emptyResult = () => ({ items: [], top: null, stats: { boundaries: 0, problematic: 0 } })

const LEVEL_WEIGHT = { error: 3, suggestion: 2, hint: 1 }
const BOUNDARY_PUNCT = new Set([',', '.', ';', ':', '?', '!'])

/** 音素是否可归类（辅音或元音）；未知符号两类都不是 → 不猜 */
function classifiable(sym) {
  return isConsonant(sym) || isVowel(sym)
}

function scoreOf(phone) {
  return typeof phone?.score === 'number' && Number.isFinite(phone.score) ? phone.score : null
}

/**
 * next 词之前是否为意群边界（标点）：在 refText 中按顺序找 next.char，
 * 看它前一个非空白字符是不是标点。找不到位置 → 视为非边界。
 */
function isBoundaryBefore(refText, nextChar, cursor) {
  if (!refText || !nextChar) return { hit: false, cursor }
  const idx = refText.indexOf(nextChar, cursor)
  if (idx < 0) return { hit: false, cursor }
  let p = idx - 1
  while (p >= 0 && /\s/.test(refText[p])) p--
  return { hit: p >= 0 && BOUNDARY_PUNCT.has(refText[p]), cursor: idx + nextChar.length }
}

/** 被排除的词：漏读/重读/未收录的词谈连读没有意义。
 *  注意 is_pause **不**排除 —— 停顿恰恰是连读失败的证据（实测 gapB-800：断开 870ms 时
 *  引擎给该词打 is_pause:1，排除它会把最强信号吞掉）。 */
function wordExcluded(w) {
  return !w || w.fakePron === true || (w.dpType ?? 0) !== 0
}

/**
 * 提取所有可判定的相邻词对及特征。返回 { boundaries, pairs }。
 * @param {{words?: Array}} parsed
 * @param {string} refText
 */
function extractBoundaries(parsed, refText) {
  const words = Array.isArray(parsed?.words) ? parsed.words : []
  const pairs = []
  let cursor = 0

  for (let i = 0; i < words.length - 1; i++) {
    const cur = words[i]
    const next = words[i + 1]
    const boundary = isBoundaryBefore(refText, next?.char, cursor)
    cursor = boundary.cursor

    if (wordExcluded(cur) || wordExcluded(next)) continue
    if (typeof cur.start !== 'number' || typeof cur.end !== 'number') continue
    if (typeof next.start !== 'number') continue
    if (!Array.isArray(cur.phones) || cur.phones.length === 0) continue
    if (!Array.isArray(next.phones) || next.phones.length === 0) continue

    const tail = cur.phones[cur.phones.length - 1]
    const head = next.phones[0]
    const tailSym = stripStress(tail?.char)
    const headSym = stripStress(head?.char)
    // 边界音素必须双方都可归类，否则丢弃该词对（不猜）
    if (!classifiable(tailSym) || !classifiable(headSym)) continue

    pairs.push({
      wordIndex: i,
      pair: [i, i + 1],
      cur,
      next,
      gapMs: next.start - cur.end,
      tailSym,
      headSym,
      tailIPA: toIPA(tailSym),
      headIPA: toIPA(headSym),
      tailScore: scoreOf(tail),
      headScore: scoreOf(head),
      boundaryBefore: boundary.hit,
    })
  }
  return { boundaries: pairs.length, pairs }
}

function makeItem(pair, id, level, message) {
  return {
    id,
    level,
    wordIndex: pair.wordIndex,
    pair: pair.pair,
    text: `${pair.cur.char} ${pair.next.char}`,
    message,
    evidence: {
      gapMs: pair.gapMs,
      tailPhone: pair.tailSym,
      tailScore: pair.tailScore,
      headPhone: pair.headSym,
      headScore: pair.headScore,
    },
  }
}

/** 三条规则：失爆上下文优先（最高只给 hint），否则按分数区间判错误/建议 */
function judge(pair) {
  const { tailScore, tailIPA, tailSym, headSym, gapMs, boundaryBefore } = pair
  if (tailScore === null) return null

  // 失爆上下文：爆破音 + 后词辅音开头 + 紧挨着。
  // 实测：native 朗读 "eat yet" 的 /t/ 只有 49~76 分，与"真漏读"在分数上不可区分，
  // 所以这个语境里**不给红色错误**，最多给中性提示。
  const elisionContext = STOP_CONSONANTS.has(tailIPA) && isConsonant(headSym) && gapMs < THRESHOLDS.GAP_STOP
  if (elisionContext) {
    if (tailScore >= THRESHOLDS.TAIL_STOP) return null
    return makeItem(pair, 'stop-elision', 'hint',
      `${pair.cur.char} 的 ${tailIPA} 被吃掉是美音常态（失爆），不是错；若你是整个词尾漏读，重录时给出 ${tailIPA} 的起始位`)
  }

  // ③ 词尾辅音丢失（非失爆语境）：明确漏发
  if (tailScore < THRESHOLDS.TAIL_LOSS) {
    return makeItem(pair, 'coda-loss', 'error',
      `${pair.cur.char} 词尾 ${tailIPA} 没发出来（美音也会发，只是很轻）`)
  }

  // ① 连读缺失：辅音尾 + 元音头 + 有明显间隙 + 尾音素偏低 + 非意群边界
  if (
    isConsonant(tailSym) &&
    isVowel(headSym) &&
    gapMs > THRESHOLDS.GAP_LINK &&
    tailScore < THRESHOLDS.TAIL_LINK &&
    !boundaryBefore
  ) {
    return makeItem(pair, 'link-missing', 'suggestion',
      `${pair.cur.char} ${pair.next.char} 该连读（${tailIPA}+${pair.headIPA} → ${tailIPA}${pair.headIPA}），你中间断了 ${gapMs}ms`)
  }

  return null
}

/** 排序：级别权重降序 → 尾音素分越低越靠前 → 位置靠前 */
function pickTop(items) {
  if (items.length === 0) return null
  const sorted = [...items].sort((a, b) => {
    const lw = (LEVEL_WEIGHT[b.level] || 0) - (LEVEL_WEIGHT[a.level] || 0)
    if (lw !== 0) return lw
    const as = a.evidence.tailScore ?? 100
    const bs = b.evidence.tailScore ?? 100
    if (as !== bs) return as - bs
    return a.wordIndex - b.wordIndex
  })
  return sorted[0]
}

/**
 * 诊断一句跟读结果。
 * @param {{words?: Array}} parsed parseResult() 的产物
 * @param {{refText?: string}} [options]
 * @returns {{items: Array, top: object|null, stats: {boundaries: number, problematic: number}}}
 */
export function diagnose(parsed, { refText = '' } = {}) {
  const { boundaries, pairs } = extractBoundaries(parsed, refText)
  if (pairs.length === 0) return emptyResult()

  const items = []
  for (const pair of pairs) {
    const item = judge(pair)
    if (item) items.push(item)
  }
  return { items, top: pickTop(items), stats: { boundaries, problematic: items.length } }
}
