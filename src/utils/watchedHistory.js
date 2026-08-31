// 观看历史：localStorage 持久化的最近观看视频 id 列表（最前=最近，去重，上限 50）。
// VideoDetail 写入；LearningRecords（观看历史）与 Profile（最近观看）读取。
const STORAGE_KEY = 'shadow_voice_watched'
const MAX_ENTRIES = 50

export function readWatchHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : []
  } catch {
    // 损坏的 JSON 或 localStorage 不可用（隐私模式等）→ 视为空历史
    return []
  }
}

export function recordWatch(id) {
  if (!id) return readWatchHistory()
  const next = [id, ...readWatchHistory().filter(x => x !== id)].slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用（隐私模式/配额超限）→ 仅返回内存中的结果，不抛错
  }
  return next
}

export function clearWatchHistory() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
