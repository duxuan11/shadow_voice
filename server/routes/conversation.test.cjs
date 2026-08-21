const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// 测试封闭：清除 AI env（防真实调用；provider 模块加载时捕获 env）
delete process.env.AI_API_KEY
delete process.env.AI_BASE_URL
delete process.env.AI_MODEL

// 临时库 + 临时数据目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-conv-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const DATA_TMP = path.join(tmpDir, 'data')
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep1'), { recursive: true })
fs.writeFileSync(path.join(DATA_TMP, 'consolidated.json'), JSON.stringify([
  { id: 'v1', episode_dir: 'ep1', title: '测试视频', level: '中级' },
]))
fs.writeFileSync(path.join(DATA_TMP, 'videos', 'ep1', 'subtitles.json'), JSON.stringify([
  { id: 's1', startTime: 0, endTime: 3, textEn: "we've just checked in and now we need to go to our room", textCn: '我们刚办好入住' },
  { id: 's2', startTime: 4, endTime: 7, textEn: "so let's take the lift", textCn: '我们去坐电梯' },
  { id: 's3', startTime: 8, endTime: 11, textEn: 'normally the concierge takes your bags', textCn: '礼宾员拿行李' },
]))
process.env.SHADOW_VOICE_DATA_DIR = DATA_TMP

const express = require('express')
const { getDb, run, get, all } = require('../db.cjs')
const { signToken } = require('../auth.cjs')

// 挂载 conversation 路由（不经过 index.cjs，避免真 listen 冲突）
const convRoutes = require('./conversation.cjs')
const app = express()
app.use(express.json())
app.use('/api/conversation', convRoutes.router)

let server, baseUrl
const USER_ID = 7

before(async () => {
  await getDb()
  // 准备一个用户（authMiddleware 需要真实存在的 userId 吗？不需要——只校验 token 签名）
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => { if (server) server.close() })

function authHeaders(userId = USER_ID) {
  return { Authorization: `Bearer ${signToken(userId)}`, 'Content-Type': 'application/json' }
}

test('游客访问 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/conversation/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: 'v1' }) })
  assert.equal(res.status, 401)
})

test('无效 token → 401', async () => {
  const res = await fetch(`${baseUrl}/api/conversation/start`, { method: 'POST', headers: { Authorization: 'Bearer invalid.token.here', 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: 'v1' }) })
  assert.equal(res.status, 401)
})

test('start 无 AI key → 201 + aiUnavailable + topics 本地', async () => {
  const res = await fetch(`${baseUrl}/api/conversation/start`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ videoId: 'v1' }) })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.aiUnavailable, true)
  assert.equal(body.opening, null)
  assert.equal(body.topics.source, 'local')
  assert.ok(body.topics.words.length >= 3)
  assert.ok(body.topics.phrases.length >= 2)
  assert.ok(body.session.id > 0)
  // 落库
  const sess = get('SELECT * FROM conversation_sessions WHERE id=?', [body.session.id])
  assert.equal(sess.user_id, USER_ID)
  assert.ok(sess.topics_json.includes('local'))
})

test('start 未知视频 → 404', async () => {
  const res = await fetch(`${baseUrl}/api/conversation/start`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ videoId: 'nope' }) })
  assert.equal(res.status, 404)
})

test('reply 无 AI key → 503 提示', async () => {
  const s = run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [USER_ID, 'v1', JSON.stringify({ words: [], phrases: [], collocations: [], source: 'local' })])
  const res = await fetch(`${baseUrl}/api/conversation/${s.lastInsertRowid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'Yes it was quick' }),
  })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /AI 未配置/)
})

test('reply 非本人会话 → 403', async () => {
  const s = run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [USER_ID + 1, 'v1', '{}'])
  const res = await fetch(`${baseUrl}/api/conversation/${s.lastInsertRowid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'hi' }),
  })
  assert.equal(res.status, 403)
})

test('reply 会话不存在 → 404', async () => {
  const res = await fetch(`${baseUrl}/api/conversation/99999/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'hi' }),
  })
  assert.equal(res.status, 404)
})

test('reply 缺 text → 400', async () => {
  const s = run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [USER_ID, 'v1', '{}'])
  const res = await fetch(`${baseUrl}/api/conversation/${s.lastInsertRowid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

test('review 无 AI key → 本地降级（不伪造分数）', async () => {
  const s = run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [USER_ID, 'v1', JSON.stringify({ words: [{ word: 'concierge' }], phrases: [], collocations: [], source: 'local' })])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [s.lastInsertRowid, 'ai', 'So you just checked in?'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [s.lastInsertRowid, 'user', 'Yes it was quick'])
  const res = await fetch(`${baseUrl}/api/conversation/${s.lastInsertRowid}/review`, { method: 'POST', headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  // 本地降级：score null，issues 空，标注 unparsed
  assert.ok(body.review)
  assert.ok(Array.isArray(body.review.turns))
  assert.equal(body.review.turns[0].score, null)
  // 落库：user 消息 score 保持 null（未伪造）
  const msg = get("SELECT * FROM conversation_messages WHERE session_id=? AND role='user'", [s.lastInsertRowid])
  assert.equal(msg.score, null)
})

test('GET /:sessionId 返回历史（本人）', async () => {
  const s = run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [USER_ID, 'v1', '{}'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [s.lastInsertRowid, 'ai', 'Hi there'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [s.lastInsertRowid, 'user', 'Hello'])
  const res = await fetch(`${baseUrl}/api/conversation/${s.lastInsertRowid}`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.session.id, s.lastInsertRowid)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'ai')
})

test('GET /:sessionId 非本人 → 403', async () => {
  const s = run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [USER_ID + 1, 'v1', '{}'])
  const res = await fetch(`${baseUrl}/api/conversation/${s.lastInsertRowid}`, { headers: authHeaders() })
  assert.equal(res.status, 403)
})
