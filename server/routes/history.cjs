const express = require('express')
const router = express.Router()
const { authMiddleware } = require('../auth.cjs')
const { getDb, run, all } = require('../db.cjs')

const MAX_ENTRIES = 50

// 修剪：只保留最近 MAX_ENTRIES 条（watched_at 最新在前，同秒按 id 倒序）
function prune(userId) {
  run(
    `DELETE FROM watch_history WHERE user_id = ? AND id NOT IN (
       SELECT id FROM watch_history WHERE user_id = ?
       ORDER BY watched_at DESC, id DESC LIMIT ${MAX_ENTRIES}
     )`,
    [userId, userId]
  )
}

// GET /api/history — 最近观看视频 id 列表（最新在前，上限 50）
router.get('/', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const rows = all(
      `SELECT video_id FROM watch_history WHERE user_id = ?
       ORDER BY watched_at DESC, id DESC LIMIT ${MAX_ENTRIES}`,
      [req.userId]
    )
    res.json({ history: rows.map(r => r.video_id) })
  } catch (err) {
    console.error('Failed to load watch history:', err)
    res.status(500).json({ error: '加载观看历史失败' })
  }
})

// POST /api/history/merge — 批量并入本机旧历史（ids 最新在前，按序写入保序）
router.post('/merge', authMiddleware, async (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必须是数组' })
  const clean = ids.filter(x => typeof x === 'string' && x)
  if (clean.length === 0) return res.json({ ok: true })
  try {
    await getDb()
    // 倒序写入：最旧的先插入（id 较小），最新的最后插入（id 较大），
    // 配合「watched_at DESC, id DESC」排序保持列表相对顺序。
    for (let i = clean.length - 1; i >= 0; i--) {
      run('DELETE FROM watch_history WHERE user_id = ? AND video_id = ?', [req.userId, clean[i]])
      run(
        `INSERT INTO watch_history (user_id, video_id, watched_at)
         VALUES (?, ?, datetime('now'))`,
        [req.userId, clean[i]]
      )
    }
    prune(req.userId)
    res.json({ ok: true })
  } catch (err) {
    console.error('Failed to merge watch history:', err)
    res.status(500).json({ error: '合并观看历史失败' })
  }
})

// POST /api/history/:videoId — 记录一次观看（已存在则置顶）
router.post('/:videoId', authMiddleware, async (req, res) => {
  const { videoId } = req.params
  if (!videoId) return res.status(400).json({ error: '缺少视频 ID' })
  try {
    await getDb()
    // 先删后插，使重看产生新的自增 id → 在「watched_at DESC, id DESC」下可靠置顶
    // （datetime('now') 秒级精度，同秒内仅靠时间戳无法区分先后）。
    run('DELETE FROM watch_history WHERE user_id = ? AND video_id = ?', [req.userId, videoId])
    run(
      `INSERT INTO watch_history (user_id, video_id, watched_at)
       VALUES (?, ?, datetime('now'))`,
      [req.userId, videoId]
    )
    prune(req.userId)
    res.json({ ok: true })
  } catch (err) {
    console.error('Failed to record watch:', err)
    res.status(500).json({ error: '记录观看失败' })
  }
})

// DELETE /api/history — 清空该用户全部观看历史
router.delete('/', authMiddleware, async (req, res) => {
  try {
    await getDb()
    run('DELETE FROM watch_history WHERE user_id = ?', [req.userId])
    res.json({ ok: true })
  } catch (err) {
    console.error('Failed to clear watch history:', err)
    res.status(500).json({ error: '清空观看历史失败' })
  }
})

module.exports = router
