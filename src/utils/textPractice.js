// 文本练习的纯函数工具：句子/进度计数、续练位置、评分回显。
// 页面（TextPracticePage / TextDocPage）只做渲染与请求，判断逻辑集中在这里以便单测。

/** 所有句子都有中文译文 */
export function cnReady(sentences) {
  const list = Array.isArray(sentences) ? sentences : []
  return list.length > 0 && list.every((s) => String(s?.cn ?? '').trim())
}

/** 缺中文的句数 */
export function missingCnCount(sentences) {
  const list = Array.isArray(sentences) ? sentences : []
  return list.filter((s) => !String(s?.cn ?? '').trim()).length
}

/** 已跟读过的句数 */
export function shadowDoneCount(progress) {
  const list = progress?.shadow
  return Array.isArray(list) ? list.length : 0
}

/** 已作答（汉译英）的句数 */
export function translateDoneCount(progress) {
  const list = progress?.answers
  return Array.isArray(list) ? list.length : 0
}

/** 百分比，0–100 整数；total 非正返回 0 */
export function percent(done, total) {
  const t = Number(total)
  if (!Number.isFinite(t) || t <= 0) return 0
  const d = Number(done)
  const value = Number.isFinite(d) ? (d / t) * 100 : 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * 续练位置：从 cursor 起找第一条没有记录的句子；都没有记录就从 cursor 开始；
 * cursor 越界或全部练完则回退到最后一屏。
 * @param {Array<{ index: number }>} records
 * @param {number} cursor
 * @param {number} total
 */
export function resumeIndex(records, cursor, total) {
  const count = Math.floor(Number(total) || 0)
  if (count <= 0) return 0
  const done = new Set(
    (Array.isArray(records) ? records : [])
      .map((r) => Number(r?.index))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < count)
  )
  const rawCursor = Math.floor(Number(cursor) || 0)
  const start = Math.min(Math.max(rawCursor, 0), count - 1)
  for (let i = start; i < count; i++) {
    if (!done.has(i)) return i
  }
  return start
}

/** 该句的跟读记录（含最佳分），没有返回 null */
export function findShadow(shadow, index) {
  if (!Array.isArray(shadow)) return null
  return shadow.find((s) => s && s.index === index) || null
}

/** 把落库的作答记录还原成结果卡数据结构（无记录返回 null） */
export function reviewFromSavedAnswer(answer) {
  if (!answer || typeof answer !== 'object') return null
  return {
    verdict: answer.verdict || 'wrong',
    score: Number.isFinite(Number(answer.score)) && answer.score !== null ? Number(answer.score) : null,
    issues: Array.isArray(answer.issues) ? answer.issues : [],
    better: String(answer.better ?? ''),
    praise: String(answer.praise ?? ''),
    hint: '',
    parseError: false,
  }
}

/** 平均分（忽略 null 分数），无有效分数返回 null */
export function avgScore(answers) {
  const scores = (Array.isArray(answers) ? answers : [])
    .map((a) => a?.score)
    .filter((s) => s !== null && s !== undefined && Number.isFinite(Number(s)))
    .map((s) => Number(s))
  if (scores.length === 0) return null
  return Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length)
}

/** 状态中文标签 */
export function statusLabel(status) {
  return status === 'completed' ? '已完成' : '进行中'
}

/**
 * 展示用日期：SQLite 的 `datetime('now')` 是 UTC 且不带时区标记，
 * 直接 new Date() 会被当本地时间（中国用户晚上会差一天），这里补 Z 再格式化。
 */
export function formatDate(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/** 编辑时的请求体：正文没变就只发标题，避免服务端重切句/清进度 */
export function buildUpdatePayload({ title, text, originalText }) {
  const payload = { title }
  if (String(text ?? '') !== String(originalText ?? '')) payload.text = text
  return payload
}

/** 首屏默认 Tab：已练完的文本先看完成面板 */
export function initialTab(progress) {
  return progress?.status === 'completed' ? 'translate' : 'shadow'
}
