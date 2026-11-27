// 音素符号 → IPA 映射 + 辅音/元音判定。
//
// 背景（2026-11-26 spike 实测）：阿里云评测返回的 `phone[].char` 是**混合符号集** ——
// 大部分是 ARPAbet（`aa`/`ih`/`ay`/`aw`），部分已是 IPA（`aɪ`/`aʊ`/`æ`/`ɒ`/`ɪə`），
// 还有重音前缀形式（`'p`，实测出现在 `possible` 的首音素）。英文结果实测 47 个唯一符号，
// 其中存在同义重复（`ay`/`aɪ`、`aa`/`ɑ`、`aw`/`aʊ`）。因此这里做三件事：
//   1) 把别名归一到同一个 IPA 表示；
//   2) 剥离 `'` 重音前缀；
//   3) 提供辅音/元音判定，**未收录符号既不判辅音也不判元音**（让调用方丢弃该词对，不猜）。

// ARPAbet + 实测 IPA 变体 → IPA。
// 额外收录 th/sh/ch/dh/zh/er/oy/ao/uh 等本次样本没出现、但真实句子必然出现的音素，
// 避免常见单词（the/this/she/chair…）落到"未知符号"而降级。
export const PHONE_IPA = {
  // 元音
  aa: 'ɑ',
  ao: 'ɔ',
  ah: 'ʌ',
  ae: 'æ',
  ax: 'ə',
  ә: 'ə',
  er: 'ɚ',
  eh: 'ɛ',
  ih: 'ɪ',
  iy: 'i',
  uh: 'ʊ',
  uw: 'u',
  oo: 'u',
  'u:': 'u',
  u: 'u',
  i: 'i',
  e: 'e',
  ay: 'aɪ',
  aɪ: 'aɪ',
  ey: 'eɪ',
  ow: 'oʊ',
  oy: 'ɔɪ',
  aw: 'aʊ',
  aʊ: 'aʊ',
  ir: 'ɪr',
  'ɪə': 'ɪə',
  æ: 'æ',
  ɑ: 'ɑ',
  ɒ: 'ɒ',
  ɛ: 'ɛ',
  ɪ: 'ɪ',
  // 辅音
  b: 'b',
  ch: 'tʃ',
  d: 'd',
  dh: 'ð',
  f: 'f',
  g: 'g',
  h: 'h',
  hh: 'h',
  j: 'dʒ',
  k: 'k',
  l: 'l',
  m: 'm',
  n: 'n',
  ng: 'ŋ',
  p: 'p',
  r: 'r',
  s: 's',
  sh: 'ʃ',
  t: 't',
  th: 'θ',
  v: 'v',
  w: 'w',
  y: 'j',
  z: 'z',
  zh: 'ʒ',
}

const VOWEL_IPA = new Set([
  'ɑ', 'aɪ', 'ʌ', 'aʊ', 'ə', 'e', 'ɛ', 'eɪ', 'i', 'ɪ', 'ɪr', 'oʊ', 'u', 'ɪə', 'ɒ', 'æ', 'ɔ', 'ɔɪ', 'ʊ', 'ɚ',
])

const CONSONANT_IPA = new Set([
  'p', 'b', 't', 'd', 'k', 'g', 'f', 'v', 's', 'z', 'h', 'm', 'n', 'l', 'r', 'w', 'j', 'ŋ', 'dʒ', 'tʃ', 'θ', 'ð', 'ʃ', 'ʒ',
])

/**
 * 剥离重音前缀 `'`。非字符串/空 → 空串。
 * @param {unknown} sym 例如 "'p"
 * @returns {string} 例如 "p"
 */
export function stripStress(sym) {
  if (typeof sym !== 'string') return ''
  return sym.replace(/^'+/, '').trim()
}

/**
 * 音素符号 → IPA。未收录的符号原样返回（降级展示，不抛错）。
 * @param {unknown} sym
 * @returns {string}
 */
export function toIPA(sym) {
  const bare = stripStress(sym)
  if (!bare) return ''
  return PHONE_IPA[bare] ?? bare
}

/**
 * 是否辅音。未收录符号返回 false（调用方据此丢弃判定，不猜）。
 * @param {unknown} sym
 * @returns {boolean}
 */
export function isConsonant(sym) {
  return CONSONANT_IPA.has(toIPA(sym))
}

/**
 * 是否元音。未收录符号返回 false。
 * @param {unknown} sym
 * @returns {boolean}
 */
export function isVowel(sym) {
  return VOWEL_IPA.has(toIPA(sym))
}
