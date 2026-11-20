// 每日口语挑战页面的纯逻辑：步骤状态、恢复位置、语音统计、对话轮次、报告分堆。
// 无副作用、不抛错；页面只负责渲染与网络请求。

export const STEP_META = [
  { step: 1, key: 'recall', title: 'Video Recall', cn: '视频复述' },
  { step: 2, key: 'chunks', title: 'Chunk Activation', cn: '语块激活' },
  { step: 3, key: 'transform', title: 'Sentence Transformation', cn: '情境转换' },
  { step: 4, key: 'topic', title: 'Topic Speaking', cn: '话题表达' },
  { step: 5, key: 'chat', title: 'AI Conversation', cn: 'AI 对话' },
]

export const STEP_COUNT = STEP_META.length
// 「第几步」用 0..4 当索引，5 表示「看报告」
export const REPORT_STEP = 5

export const CHAT_MIN_TURNS = 5
export const CHAT_MAX_TURNS = 8

export const FILLER_WORDS = ['um', 'uh', 'erm', 'ah', 'like', 'you know', 'i mean']

function asStr(v) {
  return String(v ?? '')
}

// 某一步的状态：done（有反馈）/ answered（已作答但还没反馈）/ todo
export function stepStatus(steps, step) {
  const i = Number(step) - 1
  const record = Array.isArray(steps) && i >= 0 ? steps[i] : null
  if (!record || typeof record !== 'object') return 'todo'
  if (record.status === 'completed') return 'done'
  if (record.status === 'answered') return 'answered'
  return 'todo'
}

// 恢复时该进哪一步：已完成 → 报告（5）；否则第一个未完成的步（0-based）
export function resumeStep(progress) {
  if (!progress || typeof progress !== 'object') return 0
  if (progress.status === 'completed') return REPORT_STEP
  const steps = Array.isArray(progress.steps) ? progress.steps : []
  for (let i = 0; i < STEP_COUNT; i += 1) {
    if (steps[i]?.status !== 'completed') return i
  }
  return REPORT_STEP
}

export function countWords(text) {
  return asStr(text).trim().split(/\s+/).filter(Boolean).length
}

// 语速（词/分钟）；说话时长不足 5 秒不给数字（避免 1 个词算出 1000 wpm）
export function wpm(words, activeMs) {
  const ms = Number(activeMs)
  const n = Number(words)
  if (!Number.isFinite(ms) || ms < 5000 || !Number.isFinite(n) || n <= 0) return null
  return Math.round(n / (ms / 60000))
}

// 分段录音的文本拼接：任一段为空不影响，段间只留一个空格
export function mergeSegmentText(prev, next) {
  const a = asStr(prev).replace(/\s+/g, ' ').trim()
  const b = asStr(next).replace(/\s+/g, ' ').trim()
  if (!a) return b
  if (!b) return a
  return `${a} ${b}`
}

// attempts 每次尝试一条（调用方先把同一次尝试的多段 durationMs 相加）
export function aggregateSpeaking(attempts) {
  let longest = 0
  let total = 0
  let segments = 0
  for (const a of Array.isArray(attempts) ? attempts : []) {
    const ms = Math.max(0, Number(a?.durationMs) || 0)
    const sg = Math.max(0, Number(a?.segments) || 0)
    if (!ms) continue
    longest = Math.max(longest, ms)
    total += ms
    segments += sg
  }
  return {
    longestSeconds: Math.round(longest / 1000),
    totalSeconds: Math.round(total / 1000),
    segments,
  }
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 命中的填充词（去重，按词表顺序）
export function countFillers(text, list = FILLER_WORDS) {
  const hay = ` ${asStr(text).toLowerCase()} `
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const word = asStr(raw).trim().toLowerCase()
    if (!word) continue
    const re = new RegExp(`(^|[^a-z])${escapeRe(word)}([^a-z]|$)`)
    if (re.test(hay) && !out.includes(word)) out.push(word)
  }
  return out
}

export function chatUserTurns(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'user').length
}

export function canFinishChat(messages) {
  const userTurns = chatUserTurns(messages)
  if (userTurns >= CHAT_MAX_TURNS) return { can: true, reason: 'max', userTurns }
  if (userTurns < CHAT_MIN_TURNS) {
    return { can: false, reason: `还需要 ${CHAT_MIN_TURNS - userTurns} 轮`, userTurns }
  }
  return { can: true, reason: 'ok', userTurns }
}

// 报告四堆：兼容缺失字段（老报告没有 introduced）
export function reportBuckets(mastery) {
  const m = mastery && typeof mastery === 'object' ? mastery : {}
  const pick = (v) => (Array.isArray(v) ? v : [])
  return {
    mastered: pick(m.mastered),
    selfUsed: pick(m.selfUsed),
    review: pick(m.review),
    introduced: pick(m.introduced),
  }
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function clampServerText(text, max = 2000) {
  return asStr(text).slice(0, Math.max(0, Number(max) || 0))
}

// 把英文原句遮成圆点，用于 Step 2 提交前隐藏答案（只遮字母，保留词距以便看出长度）
export function maskEvidence(text) {
  const s = asStr(text).trim()
  if (!s) return ''
  return s.replace(/[A-Za-z][A-Za-z'’]*/g, (w) => '•'.repeat(Math.max(2, Math.min(w.length, 6))))
}
