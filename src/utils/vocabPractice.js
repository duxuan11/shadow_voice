// 生词「听练一体」纯函数：类型标签、洗牌组轮、熟练度、按类型汇总。
// 零副作用，便于单测；页面组件只负责渲染与请求。
import { normalizeVocabKey } from './vocabulary.js'

// 听练 UI 名称：core_phrase 展示为「句子」（存储 type 不变，不做数据迁移）。
export const PRACTICE_TYPE_LABELS = { word: '单词', phrase: '短语', core_phrase: '句子' }

export const PRACTICE_TYPE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'word', label: '单词' },
  { id: 'phrase', label: '短语' },
  { id: 'core_phrase', label: '句子' },
]

const PRACTICE_TYPES = ['word', 'phrase', 'core_phrase']

/** Fisher-Yates 洗牌；返回新数组，不改动入参。rand 可注入以便测试。 */
export function shuffle(list, rand = Math.random) {
  const out = (list || []).slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * 组装本轮题目队列。
 * - 传 word：单条成轮（按规范化 key 匹配，忽略大小写/标点）。
 * - 否则按 type 筛选后洗牌；type 为 'all' 或空 → 全部。
 */
export function buildPracticeQueue(vocabulary, { type = 'all', word = '' } = {}) {
  const list = vocabulary || []
  const key = normalizeVocabKey(word)
  if (key) {
    const entry = list.find(v => (v.word || normalizeVocabKey(v.content)) === key)
    return entry ? [entry] : []
  }
  const filtered = type && type !== 'all'
    ? list.filter(v => (v.type || 'word') === type)
    : list.slice()
  return shuffle(filtered)
}

/** 由正确/练习次数推导熟练度。不落库，避免状态不一致。 */
export function proficiencyFrom(correctCount, practiceCount) {
  const practice = Number(practiceCount) || 0
  const correct = Number(correctCount) || 0
  if (practice <= 0) return { percent: 0, level: 'new', label: '未练' }
  const percent = Math.round((correct / practice) * 100)
  if (percent < 60) return { percent, level: 'weak', label: '生疏' }
  if (percent < 85) return { percent, level: 'fair', label: '一般' }
  return { percent, level: 'good', label: '熟练' }
}

/** 读取单个生词条目的熟练度。 */
export function proficiencyOf(entry) {
  return proficiencyFrom(entry?.correct_count, entry?.practice_count)
}

/** 按类型汇总练习次数 / 正确次数 / 熟练度（各类型之和）。 */
export function summarizePracticeByType(vocabulary) {
  const out = {}
  for (const type of PRACTICE_TYPES) {
    out[type] = { type, total: 0, practiceCount: 0, correctCount: 0, proficiency: proficiencyFrom(0, 0) }
  }
  for (const entry of vocabulary || []) {
    const type = entry.type || 'word'
    const bucket = out[type]
    if (!bucket) continue
    bucket.total += 1
    bucket.practiceCount += Number(entry.practice_count) || 0
    bucket.correctCount += Number(entry.correct_count) || 0
  }
  for (const type of Object.keys(out)) {
    const b = out[type]
    b.proficiency = proficiencyFrom(b.correctCount, b.practiceCount)
  }
  return out
}
