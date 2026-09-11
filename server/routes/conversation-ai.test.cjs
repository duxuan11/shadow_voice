const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// ── AI 路径回归测试：AI_API_KEY 置为测试值 + stub fetch，全程不调真实 AI ──
process.env.AI_API_KEY = 'test-key-for-unit-tests'
process.env.AI_BASE_URL = 'https://mock.invalid/v1'
process.env.AI_MODEL = 'mock-model'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-conv-ai-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const DATA_TMP = path.join(tmpDir, 'data')
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep1'), { recursive: true })
fs.writeFileSync(path.join(DATA_TMP, 'consolidated.json'), JSON.stringify([
  { id: 'v1', episode_dir: 'ep1', title: '测试视频', level: '中级' },
  { id: 'v2', episode_dir: 'ep1', title: '测试视频二', level: '初级' },
]))
fs.writeFileSync(path.join(DATA_TMP, 'videos', 'ep1', 'subtitles.json'), JSON.stringify([
  { id: 's1', startTime: 0, endTime: 3, textEn: "we've just checked in and now we need to go to our room", textCn: '我们刚办好入住' },
]))
process.env.SHADOW_VOICE_DATA_DIR = DATA_TMP

// stub fetch：只拦截 AI chat/completions（按 prompt 内容区分 opening/reply/review），
// 其余请求（测试自身调用的 HTTP）透传真实 fetch
let fetchMode = 'normal' // 'normal' | 'fail'
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes('/chat/completions')) return realFetch(url, opts)
  if (fetchMode === 'fail') throw new Error('mock network down')
  const body = JSON.parse(opts.body)
  const sysContent = body.messages[0].content
  const userContent = body.messages[1].content
  let content
  if (sysContent.includes('design a role-play scenario')) {
    content = JSON.stringify({
      scene: 'Hotel Check-in', sceneCn: '酒店入住',
      setting: 'front desk', userRole: 'guest', userRoleCn: '客人',
      aiRole: 'front desk receptionist', aiRoleCn: '前台接待',
      context: 'check in', contextCn: '办理入住',
      coreExpressions: [{ phrase: 'check in', meaning: '办理入住' }],
    })
  } else if (userContent.includes('Review the learner')) {
    content = JSON.stringify({
      turns: [
        { turn: 1, score: 80, issues: [{ type: 'grammar', location: 'x', problem: 'p', suggestion: 's', better: 'b' }], praise: 'good' },
        { turn: 2, score: 70, issues: [], praise: 'ok' },
        { turn: 3, score: 85, issues: [], praise: 'nice' },
      ],
      summary: '整体不错',
      best_turn: 3,
    })
  } else if (userContent.includes('Continue:')) {
    content = JSON.stringify({ reply: 'Nice! What did the concierge help you with?' })
  } else {
    content = JSON.stringify({ reply: 'So you just checked in. Was it quick?' })
  }
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

const express = require('express')
const { getDb, run, get, all } = require('../db.cjs')
const { signToken } = require('../auth.cjs')

const convRoutes = require('./conversation.cjs')
const app = express()
app.use(express.json())
app.use('/api/conversation', convRoutes.router)

let server, baseUrl
const USER_ID = 11
const authHeaders = () => ({ Authorization: `Bearer ${signToken(USER_ID)}`, 'Content-Type': 'application/json' })

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => { if (server) server.close() })

// 造一个会话：ai(1) user(2) ai(3) user(4) ai(5) user(6)
function seedSession(videoId = 'v1', userId = USER_ID) {
  const s = run('INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
    [userId, videoId, JSON.stringify({ words: [{ word: 'concierge' }], phrases: [{ phrase: 'check in', meaning: '办理入住' }], collocations: [], source: 'ai' })])
  const sid = s.lastInsertRowid
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [sid, 'ai', 'So you just checked in?'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [sid, 'user', 'Yes it was quick'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [sid, 'ai', 'Nice! The concierge helped you?'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [sid, 'user', 'No, I stay here before'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [sid, 'ai', 'Interesting!'])
  run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [sid, 'user', 'The hotel has a new spa'])
  return sid
}

test('P0 回归：review 写回按位置映射（不信任 AI 返回的 turn 编号）', async () => {
  const sid = seedSession()
  // AI 故意返回顺序编号 1,2,3（真实 user 消息 id 是 2,4,6）
  const res = await fetch(`${baseUrl}/api/conversation/${sid}/review`, { method: 'POST', headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.review.turns.length, 3)
  // 写回断言：id 2 → 80, id 4 → 70, id 6 → 85
  const m2 = get('SELECT score FROM conversation_messages WHERE id=2')
  const m4 = get('SELECT score FROM conversation_messages WHERE id=4')
  const m6 = get('SELECT score FROM conversation_messages WHERE id=6')
  assert.equal(m2.score, 80)
  assert.equal(m4.score, 70)
  assert.equal(m6.score, 85)
  // 轮次编号用于展示（1-based），不是 DB id
  assert.equal(body.review.turns[0].turn, 1)
})

test('A5：review 后 status=completed + review_json 落库，GET 可回看', async () => {
  const sid = seedSession()
  await fetch(`${baseUrl}/api/conversation/${sid}/review`, { method: 'POST', headers: authHeaders() })
  const sess = get('SELECT status, completed_at, review_json FROM conversation_sessions WHERE id=?', [sid])
  assert.equal(sess.status, 'completed')
  assert.ok(sess.completed_at)
  const parsed = JSON.parse(sess.review_json)
  assert.equal(parsed.summary, '整体不错')
  assert.equal(parsed.best_turn, 3)

  const res = await fetch(`${baseUrl}/api/conversation/${sid}`, { headers: authHeaders() })
  const data = await res.json()
  assert.equal(data.session.status, 'completed')
  assert.equal(data.session.review.summary, '整体不错')
  assert.equal(data.messages.length, 6)
})

test('P1a 回归：reply AI 失败 → 503 且不落孤儿 user 消息', async () => {
  const sid = seedSession()
  const before = all('SELECT * FROM conversation_messages WHERE session_id=?', [sid]).length
  fetchMode = 'fail'
  try {
    const res = await fetch(`${baseUrl}/api/conversation/${sid}/reply`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'This turn should not persist' }),
    })
    assert.equal(res.status, 503)
  } finally {
    fetchMode = 'normal'
  }
  const after = all('SELECT * FROM conversation_messages WHERE session_id=?', [sid]).length
  assert.equal(after, before, 'AI 失败时用户消息不应入库')
})

test('reply 成功：双消息落库 + targetPhrase 返回', async () => {
  const sid = seedSession()
  const res = await fetch(`${baseUrl}/api/conversation/${sid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'Yes, the concierge took our bags' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.aiReply, 'Nice! What did the concierge help you with?')
  assert.deepEqual(body.targetPhrase, { phrase: 'check in', meaning: '办理入住' })
  const msgs = all("SELECT role FROM conversation_messages WHERE session_id=? ORDER BY id", [sid])
  const lastTwo = msgs.slice(-2)
  assert.deepEqual(lastTwo.map(m => m.role), ['user', 'ai'])
})

test('reply completed 会话 → 400', async () => {
  const sid = seedSession()
  await fetch(`${baseUrl}/api/conversation/${sid}/review`, { method: 'POST', headers: authHeaders() })
  const res = await fetch(`${baseUrl}/api/conversation/${sid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'hi' }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /已结束/)
})

test('20 轮上限', async () => {
  const sid = seedSession()
  for (let i = 0; i < 18; i++) {
    run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [sid, 'user', `extra ${i}`])
  }
  // 现在 user 消息 20 条（2 条 seed + 18 条 extra）
  const res = await fetch(`${baseUrl}/api/conversation/${sid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'one more' }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /上限/)
})

test('A5：start 恢复进行中会话（resumed），newSession=true 强制新建并收尾旧的', async () => {
  // v2 造一个带消息的 active 会话
  const sid = seedSession('v2')
  // 默认 start → 恢复
  const res1 = await fetch(`${baseUrl}/api/conversation/start`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ videoId: 'v2' }),
  })
  assert.equal(res1.status, 200)
  const body1 = await res1.json()
  assert.equal(body1.resumed, true)
  assert.equal(body1.session.id, sid)
  assert.equal(body1.opening, null)

  // newSession=true → 新会话，旧的标记 completed
  const res2 = await fetch(`${baseUrl}/api/conversation/start`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ videoId: 'v2', newSession: true }),
  })
  assert.equal(res2.status, 201)
  const body2 = await res2.json()
  assert.notEqual(body2.session.id, sid)
  assert.ok(body2.opening)
  const old = get('SELECT status FROM conversation_sessions WHERE id=?', [sid])
  assert.equal(old.status, 'completed')

  // 再 start（无 newSession）→ 恢复新会话 B（有开场白消息）
  const res3 = await fetch(`${baseUrl}/api/conversation/start`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ videoId: 'v2' }),
  })
  const body3 = await res3.json()
  assert.equal(body3.resumed, true)
  assert.equal(body3.session.id, body2.session.id)
})

test('A5：GET /recent 返回最近会话列表（含视频标题/轮数/摘要）', async () => {
  const sid = seedSession('v2')
  await fetch(`${baseUrl}/api/conversation/${sid}/review`, { method: 'POST', headers: authHeaders() })
  const res = await fetch(`${baseUrl}/api/conversation/recent`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.conversations))
  assert.ok(body.conversations.length >= 1)
  const c = body.conversations[0]
  assert.ok(c.videoTitle)
  assert.ok(c.userTurns >= 1)
  assert.equal(c.status, 'completed')
})

test('场景：/start 提取场景并落库 scene_json + 返回 scene', async () => {
  const res = await fetch(`${baseUrl}/api/conversation/start`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ videoId: 'v1', newSession: true }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.scene.scene, 'Hotel Check-in')
  assert.equal(body.scene.aiRole, 'front desk receptionist')
  const sess = get('SELECT scene_json FROM conversation_sessions WHERE id=?', [body.session.id])
  assert.ok(sess.scene_json)
  assert.equal(JSON.parse(sess.scene_json).scene, 'Hotel Check-in')
})

test('场景：GET /:sessionId 返回 scene', async () => {
  const sid = seedSession()
  run('UPDATE conversation_sessions SET scene_json=? WHERE id=?',
    [JSON.stringify({ scene: 'Hotel Check-in', aiRole: 'front desk receptionist' }), sid])
  const res = await fetch(`${baseUrl}/api/conversation/${sid}`, { headers: authHeaders() })
  const data = await res.json()
  assert.equal(data.scene.scene, 'Hotel Check-in')
})

test('场景：无 scene_json 的旧会话 GET 返回 scene=null 且 reply 正常', async () => {
  const sid = seedSession()
  const res = await fetch(`${baseUrl}/api/conversation/${sid}`, { headers: authHeaders() })
  const data = await res.json()
  assert.equal(data.scene, null)
  const reply = await fetch(`${baseUrl}/api/conversation/${sid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'Yes, the concierge took our bags' }),
  })
  assert.equal(reply.status, 200)
})
