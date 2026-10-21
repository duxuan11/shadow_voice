// 中译英对话页面的纯逻辑：难度映射、进度文案、上下文、按钮策略、完成总结。
// 无副作用、不抛错；页面只负责渲染与网络请求。

export const DIFFICULTIES = ['easy', 'daily', 'advanced']

export const DIFFICULTY_LABELS = { easy: '简单', daily: '日常', advanced: '进阶' }

const LEVEL_TO_DIFFICULTY = { 初级: 'easy', 中级: 'daily', 高级: 'advanced' }

export function difficultyFromVideoLevel(level) {
  return LEVEL_TO_DIFFICULTY[String(level ?? '').trim()] || 'daily'
}

// "3/12"：显示当前句序号（1-based），越界钳制；总数为 0 时显示 0/0
export function progressLabel(cursor, total) {
  const n = Number(total)
  if (!Number.isFinite(n) || n <= 0) return '0/0'
  const c = Number(cursor)
  const clamped = Number.isFinite(c) ? Math.min(Math.max(Math.floor(c), 0), n - 1) : 0
  return `${clamped + 1}/${Math.floor(n)}`
}

// 当前句的前一句作为对话上下文；第一句 / 越界返回 null
export function contextOf(lines, index) {
  if (!Array.isArray(lines)) return null
  const i = Number(index)
  if (!Number.isInteger(i) || i <= 0 || i >= lines.length) return null
  const prev = lines[i - 1]
  if (!prev || typeof prev !== 'object') return null
  return { speakerCn: String(prev.speakerCn ?? ''), cn: String(prev.cn ?? '') }
}

// 主按钮策略：实质错误且还没重试过 → 先让用户重说，否则进下一句
export function primaryAction(review, attempts) {
  if (!review || typeof review !== 'object') return 'next'
  const n = Number(attempts) || 0
  if (review.verdict === 'wrong' && n < 2) return 'retry'
  return 'next'
}

// 上一句：第一句 / 无句子 → null（按钮置灰）；越界游标按最后一句处理
export function prevIndex(cursor, total) {
  const n = Math.floor(Number(total))
  if (!Number.isFinite(n) || n <= 0) return null
  const c = Number(cursor)
  const clamped = Math.min(Math.max(Number.isFinite(c) ? c : 0, 0), n - 1)
  return clamped > 0 ? clamped - 1 : null
}

// 下一句：已是最后一句 → null（调用方应结束练习，而不是停在原地）
export function nextIndex(cursor, total) {
  const n = Math.floor(Number(total))
  if (!Number.isFinite(n) || n <= 0) return null
  const c = Number(cursor)
  const clamped = Math.min(Math.max(Number.isFinite(c) ? c : 0, 0), n - 1)
  return clamped + 1 < n ? clamped + 1 : null
}

// 回看已答过的句子：用答题记录还原可见反馈（答案不再隐藏，因为已经练过）
export function reviewFromSavedAnswer(answer) {
  if (!answer || typeof answer !== 'object') return null
  if (typeof answer.score !== 'number') return null
  const verdict = ['correct', 'minor', 'wrong'].includes(answer.verdict)
    ? answer.verdict
    : (answer.score >= 80 ? 'correct' : answer.score >= 60 ? 'minor' : 'wrong')
  return {
    verdict,
    score: answer.score,
    issues: Array.isArray(answer.issues) ? answer.issues : [],
    better: String(answer.better ?? ''),
    praise: String(answer.praise ?? ''),
    hint: '',
    answerHidden: false,
  }
}

/**
 * 用已存答题记录确定性聚合完成总结（不调 AI）。
 * 均分只统计有分数的句子；一次通过率 = (第一次作答即 >=80 的句数) / 总句数。
 */
export function summarizeAnswers(answers, lines) {
  const lineList = Array.isArray(lines) ? lines : []
  const list = (Array.isArray(answers) ? answers : [])
    .filter((a) => a && Number.isInteger(a.index))

  const scored = list.filter((a) => typeof a.score === 'number')
  const averageScore = scored.length > 0
    ? Math.round(scored.reduce((sum, a) => sum + a.score, 0) / scored.length)
    : null

  const total = lineList.length
  const firstTryCount = list.filter((a) => a.attempts === 1 && typeof a.score === 'number' && a.score >= 80).length
  const firstTryRate = total > 0 ? Math.round((firstTryCount / total) * 100) : null

  const counts = {}
  for (const a of list) {
    for (const issue of (Array.isArray(a.issues) ? a.issues : [])) {
      const type = String(issue?.type || 'other')
      counts[type] = (counts[type] || 0) + 1
    }
  }
  const topIssues = Object.entries(counts)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([type, count]) => ({ type, count }))

  const byIndex = new Map(list.map((a) => [a.index, a]))
  const reviewLines = lineList
    .map((line, i) => ({ line, answer: byIndex.get(Number.isInteger(line?.index) ? line.index : i) }))
    .filter(({ answer }) => answer && (
      (typeof answer.score === 'number' && answer.score < 80) || (Number(answer.attempts) || 0) >= 2
    ))
    .map(({ line, answer }) => ({
      index: Number.isInteger(line?.index) ? line.index : 0,
      cn: String(line?.cn ?? ''),
      en: String(line?.en ?? ''),
      score: typeof answer.score === 'number' ? answer.score : null,
    }))
    .sort((a, b) => a.index - b.index)

  return { total, answered: list.length, averageScore, firstTryRate, topIssues, reviewLines }
}
