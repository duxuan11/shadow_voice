// 英文音标（IPA）查找。数据由 scripts/build-phonetics.mjs 离线生成并提交仓库。
//
// 词卡展示与收藏时都通过 getPhonetic() 取音标，保证 PC / 手机一致。
import PHONETICS from '../data/phonetics.js'

/**
 * 取单词的 IPA 音标；短语 / 空值 / 未命中返回空串。
 * @param {string} word
 * @returns {string} 例如 "/ɪkˈspɪɹiəns/"
 */
export function getPhonetic(word) {
  const key = String(word ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!key || key.includes(' ')) return ''
  return PHONETICS[key] || ''
}
