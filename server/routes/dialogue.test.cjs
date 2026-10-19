const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// AI 路径回归：AI_API_KEY 置为测试值 + stub fetch，全程不调真实 AI。
process.env.AI_API_KEY = 'test-key-for-unit-tests'
process.env.AI_BASE_URL = 'https://mock.invalid/v1'
process.env.AI_MODEL = 'mock-model'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dialogue-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const DATA_TMP = path.join(tmpDir, 'data')
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep1'), { recursive: true })
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep2'), { recursive: true })
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep3'), { recursive: true })
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep4'), { recursive: true })
fs.writeFileSync(path.join(DATA_TMP, 'consolidated.json'), JSON.stringify([
  { id: 'v1', episode_dir: 'ep1', title: '酒店入住', level: '中级', description: '前台办理入住' },
  { id: 'v2', episode_dir: 'ep2', title: '无字幕视频', level: '初级' },
  { id: 'v3', episode_dir: 'ep3', title: '空字幕视频', level: '高级' },
  { id: 'v4', episode_dir: 'ep4', level: '初级' },
]))
fs.writeFileSync(path.join(DATA_TMP, 'videos', 'ep1', 'subtitles.json'), JSON.stringify([
  { id: 's1', startTime: 0, endTime: 3, textEn: "we've just checked in", textCn: '我们刚办好入住' },
  { id: 's2', startTime: 4, endTime: 7, textEn: 'do you have a reservation', textCn: '请问有预订吗' },
]))
fs.writeFileSync(path.join(DATA_TMP, 'videos', 'ep3', 'subtitles.json'), JSON.stringify([]))
process.env.SHADOW_VOICE_DATA_DIR = DATA_TMP

// stub fetch：只拦 AI chat/completions，其余透传
let scriptMode = 'ok' // 'ok' | 'bad-json' | 'too-few' | 'fail'
let reviewMode = 'wrong' // 'wrong' | 'correct'
const aiCalls = { script: 0, review: 0 }
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes('/chat/completions')) return realFetch(url, opts)
  const body = JSON.parse(opts.body)
  const sys = String(body.messages[0]?.content || '')
  if (sys.includes('verdict')) {
    aiCalls.review++
    if (reviewMode === 'fail') throw new Error('mock review down')
    if (reviewMode === 'bad-json') return mockResponse('这不是 JSON，只是一段普通文本。')
    if (reviewMode === 'correct') {
      return mockResponse(JSON.stringify({ verdict: 'correct', score: 92, issues: [], better: '', praise: '很好' }))
    }
    return mockResponse(JSON.stringify({
      verdict: 'wrong', score: 45, hint: '注意时态',
      better: 'I have just checked in.',
      issues: [{ type: 'grammar', location: 'check in', problem: '时态错误', suggestion: '用现在完成时', better: 'checked in' }],
    }))
  }
  aiCalls.script++
  if (scriptMode === 'fail') throw new Error('mock network down')
  if (scriptMode === 'bad-json') return mockResponse('这不是 JSON，只是普通文本。')
  if (scriptMode === 'too-few') {
    return mockResponse(JSON.stringify({ title: '太短', lines: makeLines(3) }))
  }
  return mockResponse(JSON.stringify({
    title: '酒店入住', scene: 'Hotel Check-in', settingCn: '你在前台办理入住',
    userRole: '客人', otherRole: '前台接待', lines: makeLines(12),
  }))
}

function mockResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

function makeLines(n) {
  return Array.from({ length: n }, (_, i) => ({
    speaker: i % 2 === 0 ? 'other' : 'user',
    speakerCn: i % 2 === 0 ? '前台' : '你',
    cn: `第${i + 1}句：请问洗手间在哪边？`,
    en: `Sentence number ${i + 1}, where is the restroom?`,
    alternatives: ['Where is the restroom?'],
    keyPoints: ['礼貌问法'],
  }))
}

const express = require('express')
const { getDb, run, get, all } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const dialogueRoutes = require('./dialogue.cjs')

const app = express()
app.use(express.json())
app.use('/api/dialogue', dialogueRoutes.router)

let server, baseUrl

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => { if (server) server.close() })

function authHeaders(userId = 1) {
  return { Authorization: `Bearer ${signToken(userId)}`, 'Content-Type': 'application/json' }
}

function post(url, body, userId = 1) {
  return fetch(`${baseUrl}${url}`, { method: 'POST', headers: authHeaders(userId), body: JSON.stringify(body || {}) })
}
function put(url, body, userId = 1) {
  return fetch(`${baseUrl}${url}`, { method: 'PUT', headers: authHeaders(userId), body: JSON.stringify(body || {}) })
}
function getJson(url, userId = 1) {
  return fetch(`${baseUrl}${url}`, { headers: authHeaders(userId) })
}

test('游客 / 无效 token → 401', async () => {
  const guest = await fetch(`${baseUrl}/api/dialogue/v1?difficulty=daily`)
  assert.equal(guest.status, 401)
  const bad = await fetch(`${baseUrl}/api/dialogue/v1?difficulty=daily`, {
    headers: { Authorization: 'Bearer invalid.token.here' },
  })
  assert.equal(bad.status, 401)
})

test('GET 无脚本 → script:null 且 aiConfigured:true', async () => {
  const res = await getJson('/api/dialogue/v1?difficulty=daily', 10)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.script, null)
  assert.equal(body.progress, null)
  assert.equal(body.aiConfigured, true)
  assert.deepEqual(body.available, [])
})

test('视频不存在 → 404', async () => {
  const res = await getJson('/api/dialogue/nope?difficulty=daily', 10)
  assert.equal(res.status, 404)
})

test('generate 落库 variant=1 并建进度行（source=subtitle）', async () => {
  scriptMode = 'ok'
  const res = await post('/api/dialogue/v1/generate', { difficulty: 'daily' }, 11)
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.script.lines.length, 12)
  assert.equal(body.script.source, 'subtitle')
  assert.equal(body.script.difficulty, 'daily')
  assert.equal(body.progress.cursor, 0)
  assert.equal(body.progress.status, 'active')
  assert.deepEqual(body.progress.answers, [])

  const row = get("SELECT * FROM dialogue_scripts WHERE user_id=11 AND video_id='v1'")
  assert.equal(row.variant, 1)
  assert.equal(row.model, 'mock-model')
  const prog = get('SELECT * FROM dialogue_progress WHERE script_id=?', [row.id])
  assert.equal(prog.user_id, 11)
})

test('再次进入命中已存脚本（0 次生成调用）', async () => {
  const before = aiCalls.script
  const res = await getJson('/api/dialogue/v1?difficulty=daily', 11)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.script.lines.length, 12)
  assert.equal(body.progress.cursor, 0)
  assert.deepEqual(body.available, ['daily'])
  assert.equal(aiCalls.script, before)
})

test('再次 generate → variant=2，旧行仍在，GET 返回 variant=2', async () => {
  const res = await post('/api/dialogue/v1/generate', { difficulty: 'daily' }, 11)
  assert.equal(res.status, 201)
  const created = await res.json()

  const allRows = all("SELECT variant FROM dialogue_scripts WHERE user_id=11 AND video_id='v1' AND difficulty='daily' ORDER BY variant")
  assert.deepEqual(allRows.map(r => r.variant), [1, 2])

  const got = await (await getJson('/api/dialogue/v1?difficulty=daily', 11)).json()
  const latest = all("SELECT id FROM dialogue_scripts WHERE user_id=11 AND video_id='v1' AND difficulty='daily' ORDER BY variant DESC LIMIT 1")[0]
  assert.equal(got.progress.scriptId, latest.id)
  assert.equal(got.progress.scriptId, created.progress.scriptId)
  assert.equal(got.script.lines.length, 12)
})

test('并发生成同一难度：两个请求都成功且版本互不覆盖', async () => {
  const [a, b] = await Promise.all([
    post('/api/dialogue/v1/generate', { difficulty: 'advanced' }, 17),
    post('/api/dialogue/v1/generate', { difficulty: 'advanced' }, 17),
  ])
  assert.equal(a.status, 201)
  assert.equal(b.status, 201)
  const variants = all(
    "SELECT variant FROM dialogue_scripts WHERE user_id=17 AND difficulty='advanced' ORDER BY variant").map(r => r.variant)
  assert.deepEqual(variants, [1, 2])
})

test('无字幕且无标题/简介 → 404 信息不足（不编造）', async () => {
  const res = await post('/api/dialogue/v4/generate', { difficulty: 'easy' }, 18)
  assert.equal(res.status, 404)
  assert.equal(all('SELECT * FROM dialogue_scripts WHERE user_id=18').length, 0)
})

test('难度隔离：easy 脚本不出现在 daily 的 GET 里', async () => {
  const res = await post('/api/dialogue/v1/generate', { difficulty: 'easy' }, 11)
  assert.equal(res.status, 201)
  const daily = await (await getJson('/api/dialogue/v1?difficulty=daily', 11)).json()
  const easy = await (await getJson('/api/dialogue/v1?difficulty=easy', 11)).json()
  assert.equal(daily.script.difficulty, 'daily')
  assert.equal(easy.script.difficulty, 'easy')
  assert.deepEqual(daily.available, ['easy', 'daily'])
  const dailyProg = get('SELECT * FROM dialogue_progress WHERE script_id=?', [daily.progress.scriptId])
  const easyProg = get('SELECT * FROM dialogue_progress WHERE script_id=?', [easy.progress.scriptId])
  assert.notEqual(dailyProg.id, easyProg.id)
})

test('无字幕视频生成 → script.source === video-info', async () => {
  const noSubs = await post('/api/dialogue/v2/generate', { difficulty: 'easy' }, 12)
  assert.equal(noSubs.status, 201)
  assert.equal((await noSubs.json()).script.source, 'video-info')

  const emptySubs = await post('/api/dialogue/v3/generate', { difficulty: 'advanced' }, 12)
  assert.equal(emptySubs.status, 201)
  assert.equal((await emptySubs.json()).script.source, 'video-info')
})

test('生成结果不足 5 句 → 503 且不落盘', async () => {
  scriptMode = 'too-few'
  const res = await post('/api/dialogue/v1/generate', { difficulty: 'advanced' }, 13)
  assert.equal(res.status, 503)
  const rows = all("SELECT * FROM dialogue_scripts WHERE user_id=13")
  assert.equal(rows.length, 0)
})

test('AI 连续非法 JSON → 503 且不落盘', async () => {
  scriptMode = 'bad-json'
  const res = await post('/api/dialogue/v1/generate', { difficulty: 'advanced' }, 14)
  assert.equal(res.status, 503)
  assert.equal(all("SELECT * FROM dialogue_scripts WHERE user_id=14").length, 0)
})

test('AI 调用失败 → 503 且不落盘', async () => {
  scriptMode = 'fail'
  const res = await post('/api/dialogue/v1/generate', { difficulty: 'advanced' }, 15)
  assert.equal(res.status, 503)
  assert.equal(all("SELECT * FROM dialogue_scripts WHERE user_id=15").length, 0)
})

test('无 AI key → generate 503，GET 返回 aiConfigured:false', async () => {
  scriptMode = 'ok'
  const savedKey = process.env.AI_API_KEY
  delete process.env.AI_API_KEY
  const providerPath = require.resolve('../services/ai/provider.cjs')
  const routePath = require.resolve('./dialogue.cjs')
  delete require.cache[providerPath]
  delete require.cache[routePath]
  const freshRouter = require('./dialogue.cjs').router
  const altApp = express()
  altApp.use(express.json())
  altApp.use('/api/dialogue', freshRouter)
  const altServer = altApp.listen(0)
  await new Promise(r => altServer.once('listening', r))
  const altBase = `http://127.0.0.1:${altServer.address().port}`
  try {
    const got = await fetch(`${altBase}/api/dialogue/v2?difficulty=daily`, { headers: authHeaders(16) })
    assert.equal(got.status, 200)
    assert.equal((await got.json()).aiConfigured, false)
    const gen = await fetch(`${altBase}/api/dialogue/v1/generate`, {
      method: 'POST', headers: authHeaders(16), body: JSON.stringify({ difficulty: 'daily' }),
    })
    assert.equal(gen.status, 503)
  } finally {
    altServer.close()
    process.env.AI_API_KEY = savedKey
    delete require.cache[providerPath]
    delete require.cache[routePath]
  }
})

// ── 作答评估 ─────────────────────────────────────────────
let evScriptId = null

test('evaluate 首次 wrong → 隐藏英文答案，attempts=1 落库', async () => {
  const gen = await post('/api/dialogue/v1/generate', { difficulty: 'daily' }, 20)
  const { script, progress } = await gen.json()
  evScriptId = progress.scriptId
  const res = await post(`/api/dialogue/${evScriptId}/evaluate`,
    { index: 1, userText: 'I check in just now' }, 20)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.review.verdict, 'wrong')
  assert.equal(body.review.answerHidden, true)
  assert.equal(body.review.better, '')
  assert.equal(body.review.issues[0].better, '')
  assert.equal(body.review.hint, '注意时态')
  assert.equal(body.attempts, 1)
  assert.equal(body.progress.answers.length, 1)
  assert.equal(body.progress.answers[0].userText, 'I check in just now')
  assert.equal(script.lines.length, 12)
})

test('evaluate 第二次 → 答案可见，attempts=2', async () => {
  const res = await post(`/api/dialogue/${evScriptId}/evaluate`,
    { index: 1, userText: 'I have just checked in' }, 20)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.review.answerHidden, false)
  assert.equal(body.review.better, 'I have just checked in.')
  assert.equal(body.attempts, 2)
  const row = get('SELECT answers_json FROM dialogue_progress WHERE id=?', [body.progress.id])
  assert.ok(row.answers_json.includes('I have just checked in'))
})

test('evaluate 已答句再答 → 结果覆盖但 attempts 继续累加', async () => {
  reviewMode = 'correct'
  const res = await post(`/api/dialogue/${evScriptId}/evaluate`,
    { index: 1, userText: "I've just checked in." }, 20)
  reviewMode = 'wrong'
  const body = await res.json()
  assert.equal(body.review.verdict, 'correct')
  assert.equal(body.attempts, 3)
  assert.equal(body.progress.answers.length, 1)
})

test('evaluate index 越界 → 400', async () => {
  const res = await post(`/api/dialogue/${evScriptId}/evaluate`, { index: 99, userText: 'x y' }, 20)
  assert.equal(res.status, 400)
})

test('evaluate userText 为空（识别失败路径）→ 400 且不写库', async () => {
  const before = get('SELECT answers_json FROM dialogue_progress WHERE script_id=?', [evScriptId]).answers_json
  const res = await post(`/api/dialogue/${evScriptId}/evaluate`, { index: 2, userText: '   ' }, 20)
  assert.equal(res.status, 400)
  const after = get('SELECT answers_json FROM dialogue_progress WHERE script_id=?', [evScriptId]).answers_json
  assert.equal(after, before)
})

test('跨用户访问他人脚本 → 403', async () => {
  const res = await post(`/api/dialogue/${evScriptId}/evaluate`, { index: 0, userText: 'hello there' }, 21)
  assert.equal(res.status, 403)
  const crash = await post('/api/dialogue/999999/evaluate', { index: 0, userText: 'hello there' }, 21)
  assert.equal(crash.status, 404)
})

test('PUT progress 推进游标；到尾部自动 completed', async () => {
  const one = await put(`/api/dialogue/${evScriptId}/progress`, { cursor: 3 }, 20)
  assert.equal(one.status, 200)
  assert.equal((await one.json()).progress.cursor, 3)
  assert.equal((await (await getJson('/api/dialogue/v1?difficulty=daily', 20)).json()).progress.cursor, 3)

  const done = await put(`/api/dialogue/${evScriptId}/progress`, { cursor: 12 }, 20)
  const body = await done.json()
  assert.equal(body.progress.status, 'completed')

  const bad = await put(`/api/dialogue/${evScriptId}/progress`, { cursor: 99 }, 20)
  assert.equal(bad.status, 400)
})

test('restart 清空 answers 且 cursor=0', async () => {
  const res = await post(`/api/dialogue/${evScriptId}/restart`, {}, 20)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.progress.cursor, 0)
  assert.equal(body.progress.status, 'active')
  assert.deepEqual(body.progress.answers, [])
})

test('evaluate AI 返回非 JSON → parseError 且不写库', async () => {
  const gen = await post('/api/dialogue/v1/generate', { difficulty: 'easy' }, 30)
  const { progress } = await gen.json()
  const before = get('SELECT answers_json FROM dialogue_progress WHERE script_id=?', [progress.scriptId]).answers_json

  reviewMode = 'bad-json'
  const res = await post(`/api/dialogue/${progress.scriptId}/evaluate`, { index: 0, userText: 'hello there' }, 30)
  reviewMode = 'wrong'
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.review.parseError, true)
  assert.equal(body.review.score, null)
  assert.equal(body.review.answerHidden, true)
  const after = get('SELECT answers_json FROM dialogue_progress WHERE script_id=?', [progress.scriptId]).answers_json
  assert.equal(after, before)
})

test('evaluate AI 调用失败 → 503 且不写库', async () => {
  const gen = await post('/api/dialogue/v1/generate', { difficulty: 'easy' }, 31)
  const { progress } = await gen.json()
  const before = get('SELECT answers_json FROM dialogue_progress WHERE script_id=?', [progress.scriptId]).answers_json

  reviewMode = 'fail'
  const res = await post(`/api/dialogue/${progress.scriptId}/evaluate`, { index: 0, userText: 'hello there' }, 31)
  reviewMode = 'wrong'
  assert.equal(res.status, 503)
  const after = get('SELECT answers_json FROM dialogue_progress WHERE script_id=?', [progress.scriptId]).answers_json
  assert.equal(after, before)
})

test('POST reveal 记下 revealedAnswer，再次作答不丢该标记', async () => {
  const gen = await post('/api/dialogue/v1/generate', { difficulty: 'daily' }, 32)
  const { progress } = await gen.json()
  await post(`/api/dialogue/${progress.scriptId}/evaluate`, { index: 0, userText: 'I check in just now' }, 32)

  const reveal = await post(`/api/dialogue/${progress.scriptId}/reveal`, { index: 0 }, 32)
  assert.equal(reveal.status, 200)
  const revealBody = await reveal.json()
  assert.equal(revealBody.progress.answers[0].revealedAnswer, true)

  const again = await post(`/api/dialogue/${progress.scriptId}/evaluate`, { index: 0, userText: 'I have just checked in' }, 32)
  const againBody = await again.json()
  assert.equal(againBody.progress.answers[0].revealedAnswer, true)
  assert.equal(againBody.attempts, 2)
})
