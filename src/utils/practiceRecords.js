// 练习记录读写：登录用户走 /api/practice，游客存 localStorage。
// 记录粒度是"每句一个标志"，只用于算学习状态，不存录音/评分。

export const PRACTICE_TASKS = ['shadow', 'cloze', 'translate']
const STORAGE_KEY = 'shadow_voice_practice'

export function emptyPracticeData() {
  return { shadow: [], cloze: [], translate: [] }
}

// 纯函数：把 index 并入 task 数组，去重；非法参数原样返回
export function addIndex(data, task, index) {
  const base = data && typeof data === 'object' ? data : {}
  if (!PRACTICE_TASKS.includes(task)) return base
  if (!Number.isInteger(index) || index < 0) return base
  const current = Array.isArray(base[task]) ? base[task] : []
  if (current.includes(index)) return base
  return { ...base, [task]: [...current, index] }
}

function readLocalStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeLocalStore(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)) } catch { /* ignore */ }
}

export function loadLocalOne(videoId) {
  return readLocalStore()[videoId] || emptyPracticeData()
}

export function markLocal(videoId, task, index) {
  const store = readLocalStore()
  store[videoId] = addIndex(store[videoId] || emptyPracticeData(), task, index)
  writeLocalStore(store)
}

export function loadLocalSummary() {
  const summary = {}
  for (const [videoId, data] of Object.entries(readLocalStore())) {
    summary[videoId] = {
      shadow: Array.isArray(data?.shadow) ? data.shadow.length : 0,
      cloze: Array.isArray(data?.cloze) ? data.cloze.length : 0,
      translate: Array.isArray(data?.translate) ? data.translate.length : 0,
    }
  }
  return summary
}

export function resetLocalPractice() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

export async function loadSummary(authFetch, isGuest) {
  if (isGuest) return loadLocalSummary()
  try {
    const res = await authFetch('/practice/summary')
    if (!res.ok) return {}
    const body = await res.json()
    return body.summary || {}
  } catch {
    return {}
  }
}

export async function loadOne(authFetch, isGuest, videoId) {
  if (isGuest) return loadLocalOne(videoId)
  try {
    const res = await authFetch(`/practice/${encodeURIComponent(videoId)}`)
    if (!res.ok) return emptyPracticeData()
    const body = await res.json()
    return { ...emptyPracticeData(), ...(body.data || {}) }
  } catch {
    return emptyPracticeData()
  }
}

// 乐观记录：本地/服务端失败都不阻塞练习 UI
export function mark(authFetch, isGuest, videoId, task, index) {
  if (isGuest) {
    markLocal(videoId, task, index)
    return
  }
  authFetch(`/practice/${encodeURIComponent(videoId)}`, {
    method: 'POST',
    body: JSON.stringify({ task, index }),
  }).catch(() => {})
}
