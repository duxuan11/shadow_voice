const express = require('express')
const router = express.Router()
const { authMiddleware } = require('../auth.cjs')
const { getDb, run, get, all } = require('../db.cjs')

const TASKS = ['shadow', 'cloze', 'translate']

const emptyData = () => ({ shadow: [], cloze: [], translate: [] })

// 解析 data JSON，过滤非法项并按任务去重；损坏时返回空结构
function parseData(raw) {
  if (!raw) return emptyData()
  try {
    const obj = JSON.parse(raw)
    const out = emptyData()
    for (const t of TASKS) {
      if (Array.isArray(obj?.[t])) {
        out[t] = [...new Set(obj[t].filter(n => Number.isInteger(n) && n >= 0))]
      }
    }
    return out
  } catch {
    return emptyData()
  }
}

// GET /api/practice/summary — 必须注册在 /:videoId 之前
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const rows = all('SELECT video_id, data FROM practice_records WHERE user_id = ?', [req.userId])
    const summary = {}
    for (const row of rows) {
      const data = parseData(row.data)
      summary[row.video_id] = {
        shadow: data.shadow.length,
        cloze: data.cloze.length,
        translate: data.translate.length,
      }
    }
    res.json({ summary })
  } catch (err) {
    console.error('Failed to load practice summary:', err)
    res.status(500).json({ error: '加载学习状态失败' })
  }
})

// GET /api/practice/:videoId
router.get('/:videoId', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = get(
      'SELECT data FROM practice_records WHERE user_id = ? AND video_id = ?',
      [req.userId, req.params.videoId]
    )
    res.json({ data: row ? parseData(row.data) : emptyData() })
  } catch (err) {
    console.error('Failed to load practice record:', err)
    res.status(500).json({ error: '加载练习记录失败' })
  }
})

// POST /api/practice/:videoId  body: { task, index }
router.post('/:videoId', authMiddleware, async (req, res) => {
  try {
    const { task, index } = req.body || {}
    if (!TASKS.includes(task)) return res.status(400).json({ error: '无效的练习类型' })
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: '无效的句子索引' })

    await getDb()
    const row = get(
      'SELECT data FROM practice_records WHERE user_id = ? AND video_id = ?',
      [req.userId, req.params.videoId]
    )
    const data = row ? parseData(row.data) : emptyData()
    if (!data[task].includes(index)) data[task].push(index)

    run(
      `INSERT INTO practice_records (user_id, video_id, data, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, video_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`,
      [req.userId, req.params.videoId, JSON.stringify(data)]
    )
    res.json({ ok: true, data })
  } catch (err) {
    console.error('Failed to save practice record:', err)
    res.status(500).json({ error: '保存练习记录失败' })
  }
})

module.exports = router
