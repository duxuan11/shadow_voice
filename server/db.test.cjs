const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 临时库目录，避免污染真实 data/shadow_voice.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-db-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const db = require('./db.cjs')

test('新表在初始化后全部存在', async () => {
  await db.getDb()
  const rows = db.all("SELECT name FROM sqlite_master WHERE type='table'")
  const names = rows.map(r => r.name)
  for (const t of ['users', 'dictation_records', 'vocabulary', 'video_progress',
    'conversation_sessions', 'conversation_messages', 'ai_cache', 'watch_history',
    'practice_records']) {
    assert.ok(names.includes(t), `缺少表 ${t}`)
  }
})

test('conversation_sessions 可写入并读取', async () => {
  await db.getDb()
  const r = db.run(
    'INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?, ?, ?)',
    [1, 'video-a', JSON.stringify({ words: [{ word: 'concierge' }] })]
  )
  const row = db.get('SELECT * FROM conversation_sessions WHERE id = ?', [r.lastInsertRowid])
  assert.equal(row.user_id, 1)
  assert.equal(row.video_id, 'video-a')
  assert.equal(row.status, 'active')
  assert.ok(row.topics_json.includes('concierge'))
})

test('conversation_messages 可写入并读取（含 score/issues_json）', async () => {
  await db.getDb()
  const s = db.run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [1, 'video-a', '{}'])
  const r = db.run(
    "INSERT INTO conversation_messages (session_id, role, text, score, issues_json) VALUES (?,?,?,?,?)",
    [s.lastInsertRowid, 'user', 'I stayed here before', 76, JSON.stringify([{ type: 'grammar' }])]
  )
  const row = db.get('SELECT * FROM conversation_messages WHERE id = ?', [r.lastInsertRowid])
  assert.equal(row.role, 'user')
  assert.equal(row.text, 'I stayed here before')
  assert.equal(row.score, 76)
  assert.ok(row.issues_json.includes('grammar'))
})

test('ai_cache UNIQUE(video_id, prompt_version) 防重复', async () => {
  await db.getDb()
  db.run('INSERT INTO ai_cache (video_id, prompt_version, result) VALUES (?,?,?)',
    ['v1', 'topics-v1', '{}'])
  assert.throws(() => db.run('INSERT INTO ai_cache (video_id, prompt_version, result) VALUES (?,?,?)',
    ['v1', 'topics-v1', '{}']), /UNIQUE/)
  const rows = db.all('SELECT * FROM ai_cache WHERE video_id = ?', ['v1'])
  assert.equal(rows.length, 1)
})
