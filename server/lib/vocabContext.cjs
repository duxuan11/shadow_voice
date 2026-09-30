// 生词「中文兜底」：把生词所在字幕句子的中文作为 context_cn。
// 纯离线，不调用 AI。findContextCn 为纯函数；backfillVocabContext 做一次性幂等回填。
const fs = require('fs')
const path = require('path')
const { getDb, all, run } = require('../db.cjs')

/** 在字幕里找首个包含该词（大小写不敏感、按词边界）的句子，返回其 textCn。 */
function findContextCn(word, subtitles) {
  const needle = String(word ?? '').trim().toLowerCase()
  if (!needle || !Array.isArray(subtitles)) return ''
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[^a-z0-9'])${esc}([^a-z0-9']|$)`, 'i')
  for (const s of subtitles) {
    if (s && typeof s.textEn === 'string' && s.textCn && re.test(s.textEn)) {
      return String(s.textCn).trim()
    }
  }
  return ''
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 幂等确保 vocabulary.context_cn 列存在。
 * Task 2 会在 db.cjs 注册该列迁移；这里兜底，保证本模块可独立运行与测试。
 */
function ensureContextCnColumn(db) {
  const cols = (db.exec('PRAGMA table_info(vocabulary)')[0]?.values || []).map(r => r[1])
  if (!cols.includes('context_cn')) {
    db.run('ALTER TABLE vocabulary ADD COLUMN context_cn TEXT')
  }
}

/** 为 translation 为空且 context_cn 为空的生词行补写句子中文（幂等）。 */
async function backfillVocabContext(dataDir) {
  const db = await getDb()
  ensureContextCnColumn(db)
  const rows = all(
    `SELECT id, word, sources, video_id FROM vocabulary
     WHERE (translation IS NULL OR translation = '')
       AND (context_cn IS NULL OR context_cn = '')`
  )
  if (rows.length === 0) return { filled: 0 }

  const consolidated = loadJson(path.join(dataDir, 'consolidated.json')) || []
  const episodeById = new Map()
  for (const v of consolidated) if (v && v.id) episodeById.set(v.id, v.episode_dir)
  const subCache = new Map()
  const subsFor = (ep) => {
    if (!ep) return []
    if (!subCache.has(ep)) {
      subCache.set(ep, loadJson(path.join(dataDir, 'videos', ep, 'subtitles.json')) || [])
    }
    return subCache.get(ep)
  }

  let filled = 0
  for (const row of rows) {
    let sources = []
    try { sources = JSON.parse(row.sources || '[]') } catch { sources = [] }
    if (!Array.isArray(sources)) sources = []
    const ids = sources.map(s => s && s.videoId).filter(Boolean)
    if (ids.length === 0 && row.video_id) ids.push(row.video_id)
    let cn = ''
    for (const vid of ids) {
      cn = findContextCn(row.word, subsFor(episodeById.get(vid)))
      if (cn) break
    }
    if (cn) { run('UPDATE vocabulary SET context_cn = ? WHERE id = ?', [cn, row.id]); filled += 1 }
  }
  return { filled }
}

module.exports = { findContextCn, backfillVocabContext }
