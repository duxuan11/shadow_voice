// 语块掌握状态：完全由各步反馈里的 chunkUsage 确定性推导，不采信 AI 的自我评价。
// 状态机（design D11 / §5.2）：
//   introduced --(step2/3 用好)--> activated --(step4/5 自发用好)--> mastered
//   introduced/activated/review --(step2/3 用错)--> review
//   mastered 是终态，不会被后续失误降级。
// uses_count = used_steps 的长度（同一步重复提交不会重复计数）。

const { get, run, all } = require('../db.cjs')

const STATUSES = ['introduced', 'activated', 'mastered', 'review']

// 语块归一化：小写、统一撇号、去标点（保留词内撇号）、合并空白。
function normalizeChunkKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function nextStatus(current, { step, used, quality } = {}) {
  const cur = STATUSES.includes(current) ? current : 'introduced'
  if (cur === 'mastered') return 'mastered'
  const n = Number(step)
  const q = String(quality ?? '')
  if (n === 2 || n === 3) {
    if (q === 'good') return 'activated'
    if (q === 'partial' || q === 'wrong') return 'review'
    return cur
  }
  if (n === 4 || n === 5) {
    return used === true && q === 'good' ? 'mastered' : cur
  }
  return cur
}

function countsAsUse({ used, quality } = {}) {
  return used === true && quality === 'good'
}

function parseSteps(text) {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

// 生成新挑战时登记语块：已存在的行只更新展示文案，不回退状态。
function upsertIntroduced({ userId, videoId, chunks } = {}) {
  const list = Array.isArray(chunks) ? chunks : []
  for (const c of list) {
    const en = String(c?.en ?? '').trim()
    const key = normalizeChunkKey(en)
    if (!key) continue
    const cn = String(c?.cn ?? '').trim()
    run(
      `INSERT INTO chunk_mastery (user_id, video_id, chunk_key, chunk_en, chunk_cn, status)
       VALUES (?,?,?,?,?,'introduced')
       ON CONFLICT(user_id, video_id, chunk_key) DO UPDATE SET
         chunk_en=excluded.chunk_en, chunk_cn=excluded.chunk_cn, updated_at=datetime('now')`,
      [userId, videoId, key, en, cn]
    )
  }
}

// 按某一步的 chunkUsage 更新状态；越界/non-integer 的 chunkId 直接丢弃。
function applyUsage({ userId, videoId, chunks, chunkUsage, step, score = null } = {}) {
  const list = Array.isArray(chunks) ? chunks : []
  const byId = new Map()
  for (const c of list) {
    const id = Number(c?.id)
    if (Number.isInteger(id)) byId.set(id, c)
  }
  const usages = Array.isArray(chunkUsage) ? chunkUsage : []
  const stepNo = Number(step)

  for (const u of usages) {
    const chunkId = Number(u?.chunkId)
    if (!Number.isInteger(chunkId) || !byId.has(chunkId)) continue
    const key = normalizeChunkKey(byId.get(chunkId)?.en)
    if (!key) continue

    const row = get('SELECT * FROM chunk_mastery WHERE user_id=? AND video_id=? AND chunk_key=?',
      [userId, videoId, key])
    if (!row) continue

    const used = u?.used === true
    const quality = ['good', 'partial', 'wrong'].includes(u?.quality)
      ? u.quality
      : (used ? 'partial' : 'wrong')

    const status = nextStatus(row.status, { step: stepNo, used, quality })

    const set = new Set(parseSteps(row.used_steps))
    const countable = stepNo >= 2 && stepNo <= 5
    if (countable && countsAsUse({ used, quality })) set.add(stepNo)
    else if (countable) set.delete(stepNo)
    const usedSteps = [...set].sort((a, b) => a - b)

    const scored = countsAsUse({ used, quality }) && Number.isFinite(Number(score))
    const lastScore = scored ? Math.round(Number(score)) : (row.last_score ?? null)

    run(
      "UPDATE chunk_mastery SET status=?, uses_count=?, used_steps=?, last_score=?, updated_at=datetime('now') WHERE id=?",
      [status, usedSteps.length, JSON.stringify(usedSteps), lastScore, row.id]
    )
  }
}

function listForVideo(userId, videoId) {
  return all('SELECT * FROM chunk_mastery WHERE user_id=? AND video_id=? ORDER BY id', [userId, videoId])
}

function bucketsOf(rows) {
  const out = { mastered: [], selfUsed: [], review: [], introduced: [] }
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue
    if (r.status === 'mastered') out.mastered.push(r)
    else if (r.status === 'activated') out.selfUsed.push(r)
    else if (r.status === 'review') out.review.push(r)
    else if (r.status === 'introduced') out.introduced.push(r)
  }
  return out
}

module.exports = {
  STATUSES,
  normalizeChunkKey,
  nextStatus,
  countsAsUse,
  upsertIntroduced,
  applyUsage,
  listForVideo,
  bucketsOf,
}
