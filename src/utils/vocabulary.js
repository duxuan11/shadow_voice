// 生词本统一数据模型（词卡 → 生词本）。
//
// 词卡三个 tab 的数据结构不同（keywords / phrases / expressions），
// 这里统一成同一份「生词条目」载荷，供 VideoDetail 收藏、LearningRecords 展示复用：
//   { content, word, translation, type, phonetic, videoId, videoTitle }
// 其中 word 是用于去重的规范化 key，content 是展示原文。
//
// 纯函数、零依赖。

export const VOCAB_TYPES = ['word', 'phrase', 'core_phrase']

export const VOCAB_TYPE_LABELS = {
  word: '单词',
  phrase: '短语',
  core_phrase: '核心短语',
}

// 词卡 tab → 生词 type
export const CARD_TAB_TO_TYPE = {
  words: 'word',
  phrases: 'phrase',
  expressions: 'core_phrase',
}

/**
 * 规范化生词 key：小写、去标点（保留撇号）、合并空白。
 * 去重与删除都基于这个 key，而不是页面位置。
 */
export function normalizeVocabKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把词卡条目转成生词本载荷。
 * @param {{cardType:'words'|'phrases'|'expressions', item:object, videoId?:string, videoTitle?:string, phonetic?:string}} args
 * @returns {{content:string, word:string, translation:string, type:string, phonetic:string, videoId:string|null, videoTitle:string|null}|null}
 */
export function buildVocabPayload({ cardType, item, videoId, videoTitle, phonetic } = {}) {
  if (!item || typeof item !== 'object') return null

  let content
  let translation
  const type = CARD_TAB_TO_TYPE[cardType] || 'word'

  if (cardType === 'words') {
    content = item.word
    translation = item.meaning
  } else if (cardType === 'phrases') {
    content = item.text
    translation = item.meaning
  } else {
    content = item.textEn
    // 核心短语优先用「用法点拨」，没有则退回整句中文
    translation = item.meaning || item.textCn
  }

  content = String(content ?? '').trim()
  const word = normalizeVocabKey(content)
  if (!word) return null

  return {
    content,
    word,
    translation: String(translation ?? '').trim(),
    type,
    phonetic: String(phonetic ?? '').trim(),
    videoId: videoId || null,
    videoTitle: videoTitle || null,
  }
}

/** 在生词列表中按规范化内容查找条目。 */
export function findVocabEntry(vocabulary, content) {
  const key = normalizeVocabKey(content)
  if (!key) return null
  return (vocabulary || []).find((v) => (v.word || normalizeVocabKey(v.content)) === key) || null
}

/** 生词列表的规范化 key 集合，用于词卡按钮的「已加入」判断。 */
export function vocabKeys(vocabulary) {
  const keys = new Set()
  for (const v of vocabulary || []) {
    const key = v.word || normalizeVocabKey(v.content)
    if (key) keys.add(key)
  }
  return keys
}

/** 按类型筛选生词（'all' 或空 → 全部）。旧数据无 type 视为 word。 */
export function filterVocabByType(vocabulary, type) {
  const list = vocabulary || []
  if (!type || type === 'all') return list
  return list.filter((v) => (v.type || 'word') === type)
}

/** 统计各类型数量。 */
export function countVocabByType(vocabulary) {
  const counts = { all: (vocabulary || []).length, word: 0, phrase: 0, core_phrase: 0 }
  for (const v of vocabulary || []) {
    const type = v.type || 'word'
    if (counts[type] != null) counts[type] += 1
  }
  return counts
}
