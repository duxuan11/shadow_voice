// 跟读评测原始样本上报（dry-run）。
// 目的：积累真实学习者数据，用于 30 天后标定 src/data/linkRules.js 的诊断阈值。
// 隐私与体积：不存 audioUrl（阿里云侧录音 1 个月失效，且语音存储属合规敏感项）；
//             单条 result 上限 64KB；保留 30 天，写入时顺带清理。
const express = require('express')
const { authMiddleware } = require('../auth.cjs')
const { getDb, run } = require('../db.cjs')

const router = express.Router()

const MAX_RESULT_BYTES = 64 * 1024
const RETENTION_DAYS = 30

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const jsonOrNull = (v) => (v === undefined ? null : JSON.stringify(v))

// 剔除录音地址（可能有嵌套形状，递归处理）
function stripAudioUrl(value) {
  if (Array.isArray(value)) return value.map(stripAudioUrl)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'audioUrl') continue
    out[k] = stripAudioUrl(v)
  }
  return out
}

// POST /api/shadow-eval/samples
router.post('/samples', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}
    const refText = String(b.refText ?? '').trim()
    if (!refText) return res.status(400).json({ error: '缺少评测文本 refText' })
    // subIndex 可缺省（文本练习的跟读没有句序）；给了就必须是非负整数
    if (b.subIndex !== undefined && b.subIndex !== null && (!Number.isInteger(b.subIndex) || b.subIndex < 0)) {
      return res.status(400).json({ error: 'subIndex 必须是非负整数' })
    }
    const subIndex = Number.isInteger(b.subIndex) && b.subIndex >= 0 ? b.subIndex : null

    const resultJson = JSON.stringify(stripAudioUrl(b.result) ?? null)
    if (resultJson.length > MAX_RESULT_BYTES) {
      return res.status(400).json({ error: '评测结果过大' })
    }

    await getDb()
    const { lastInsertRowid } = run(
      `INSERT INTO shadow_eval_samples
         (user_id, video_id, sub_index, ref_text, accent, eval_accent,
          overall, accuracy, integrity, params, result, diagnosis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.userId,
        strOrNull(b.videoId),
        subIndex,
        refText,
        strOrNull(b.accent),
        strOrNull(b.evalAccent),
        numOrNull(b.overall),
        numOrNull(b.accuracy),
        numOrNull(b.integrity),
        jsonOrNull(b.params),
        resultJson,
        jsonOrNull(b.diagnosis),
      ],
    )
    run(`DELETE FROM shadow_eval_samples WHERE created_at < datetime('now','-${RETENTION_DAYS} days')`)
    return res.status(201).json({ ok: true, id: lastInsertRowid })
  } catch (err) {
    console.error('Failed to save shadow eval sample:', err?.message || err)
    return res.status(500).json({ error: '保存评测样本失败' })
  }
})

module.exports = { router }
