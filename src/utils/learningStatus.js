// 视频学习状态：以视频为单位，由三项练习记录算出完成度。
// 任务：跟读 / 挖空 / 中译英。完成度 = 三项（去重句数 / 字幕总句数）的算术平均。
// 状态：全 0 → not_learned；>= 75% → learned；其余 → learning。

export const TASKS = ['shadow', 'cloze', 'translate']
export const LEARNED_THRESHOLD = 0.75

function countOf(counts, task) {
  const n = Number(counts?.[task])
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function computeVideoProgress(counts, subtitleCount) {
  const total = Number(subtitleCount)
  if (!Number.isFinite(total) || total <= 0) return 0
  const sum = TASKS.reduce((acc, task) => acc + Math.min(1, countOf(counts, task) / total), 0)
  return sum / TASKS.length
}

export function hasAnyPractice(counts) {
  return TASKS.some(task => countOf(counts, task) > 0)
}

export function getLearningStatus(counts, progress) {
  if (!hasAnyPractice(counts)) return 'not_learned'
  return progress >= LEARNED_THRESHOLD ? 'learned' : 'learning'
}
