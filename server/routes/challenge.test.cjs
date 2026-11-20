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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-challenge-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const DATA_TMP = path.join(tmpDir, 'data')
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep1'), { recursive: true })
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep2'), { recursive: true })
fs.writeFileSync(path.join(DATA_TMP, 'consolidated.json'), JSON.stringify([
  {
    id: 'v1', episode_dir: 'ep1', title: '出国旅行的日常', level: '中级', description: '酒店入住',
    thumbnail_local: '/data/videos/ep1/cover.png', duration: 94, topic: '旅游出行',
  },
  { id: 'v2', episode_dir: 'ep2', title: '无字幕视频', level: '初级' },
]))
const SUBS = [
  { id: 's1', startTime: 0, endTime: 3, textEn: "We'd like to check in, please.", textCn: '我们想办理入住。' },
  { id: 's2', startTime: 3, endTime: 7, textEn: 'It turns out that the room is not ready.', textCn: '结果房间还没准备好。' },
  { id: 's3', startTime: 7, endTime: 11, textEn: "Let's take the lift to the 21st floor.", textCn: '我们坐电梯到21楼吧。' },
  { id: 's4', startTime: 11, endTime: 15, textEn: 'Could you hold my bags for now?', textCn: '你能先帮我存包吗？' },
  { id: 's5', startTime: 15, endTime: 19, textEn: 'In the end we got a bigger room.', textCn: '最后我们换到了更大的房间。' },
]
fs.writeFileSync(path.join(DATA_TMP, 'videos', 'ep1', 'subtitles.json'), JSON.stringify(SUBS))
process.env.SHADOW_VOICE_DATA_DIR = DATA_TMP

// ── stub AI ────────────────────────────────────────────────
let mode = 'ok' // 'ok' | 'fail' | 'bad-json'
let feedbackPayload = null
let finishChunkUsage = null
const userPrompts = []
const calls = { feedback: 0, chat: 0, finish: 0 }
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes('/chat/completions')) return realFetch(url, opts)
  const body = JSON.parse(opts.body)
  const sys = String(body.messages?.[0]?.content || '')
  const user = String(body.messages?.[1]?.content || '')
  if (mode === 'fail') throw new Error('mock network down')
  if (mode === 'bad-json') return mockResponse('这不是 JSON。')
  if (sys.includes('学习报告')) {
    calls.finish += 1
    return mockResponse(JSON.stringify({
      chatFeedback: {
        score: 80,
        praise: '对话自然',
        chunkUsage: finishChunkUsage || [{ chunkId: 0, used: true, quality: 'good' }],
      },
      report: { score: 82, summary: '整体不错，继续保持。', nextSuggestions: ['再说慢一点', '多用本套语块'] },
    }))
  }
  if (sys.includes('对话伙伴')) {
    calls.chat += 1
    return mockResponse(JSON.stringify({ reply: `Nice, tell me more ${calls.chat}.` }))
  }
  if (sys.includes('逐题反馈')) {
    calls.feedback += 1
    return mockResponse(JSON.stringify(feedbackPayload || defaultFeedback()))
  }
  userPrompts.push({ sys, user })
  return mockResponse(JSON.stringify(challengeRaw()))
}

function defaultFeedback() {
  return {
    score: 80,
    items: [{ index: 0, comment: '不错', grammar: [{ original: 'a', better: 'b', reason: 'c' }], chunkRestored: true }],
    chunkUsage: [{ chunkId: 0, used: true, quality: 'good', evidence: 'check in' }],
    vocabulary: { level: '适中', suggestions: ['deposit'] },
    coherence: { summary: '连贯', fillers: ['um'] },
    praise: '敢于开口',
  }
}

function mockResponse(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
}

function challengeRaw() {
  return {
    title: '酒店入住 · 挑战', topicEn: 'hotel check-in', topicCn: '酒店入住',
    recall: [0, 1, 2].map(i => ({ qEn: `What happens in part ${i + 1} of the video?`, qCn: `第${i + 1}个问题？`, focusCn: '要点' })),
    chunks: [
      { en: 'check in', cn: '办理入住', evidence: "We'd like to check in, please.", usageCn: '说说办入住' },
      { en: 'it turns out that', cn: '结果……', evidence: 'It turns out that the room is not ready.', usageCn: '说一件意外' },
      { en: 'hold my bags', cn: '帮我存包', evidence: 'Could you hold my bags for now?', usageCn: '请人保管东西' },
      { en: 'in the end', cn: '最终', evidence: 'In the end we got a bigger room.', usageCn: '讲结局' },
      { en: 'take the lift', cn: '坐电梯', evidence: "Let's take the lift to the 21st floor.", usageCn: '说说怎么上楼' },
    ],
    transformations: [0, 1, 2, 3, 4].map(i => ({ situationCn: `情境${i + 1}：需要向酒店提出请求。`, targetChunkId: i, hintCn: '先说来意' })),
    topicSpeaking: { promptEn: 'Describe a travel problem.', promptCn: '讲一次旅行小麻烦。', pointsCn: ['发生什么'], targetSeconds: 90 },
  }
}

const express = require('express')
const { getDb, get, all } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const challengeRoutes = require('./challenge.cjs')

const app = express()
app.use(express.json())
app.use('/api/challenge', challengeRoutes.router)

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
function countRows(table, where = '1=1', params = []) {
  return get(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`, params).c
}

test('游客 / 无效 token → 401', async () => {
  const guest = await fetch(`${baseUrl}/api/challenge/v1`)
  assert.equal(guest.status, 401)
  const bad = await fetch(`${baseUrl}/api/challenge/v1`, { headers: { Authorization: 'Bearer bad.token.here' } })
  assert.equal(bad.status, 401)
})

test('GET 无挑战 → challenge:null、history 空、mastery 四堆皆空', async () => {
  const res = await getJson('/api/challenge/v1', 10)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.challenge, null)
  assert.equal(body.challengeId, null)
  assert.equal(body.aiConfigured, true)
  assert.deepEqual(body.history, [])
  assert.deepEqual(body.mastery, { mastered: [], selfUsed: [], review: [], introduced: [] })
  assert.equal(body.video.title, '出国旅行的日常')
})

test('视频不存在 → 404', async () => {
  const res = await getJson('/api/challenge/nope', 10)
  assert.equal(res.status, 404)
})

test('generate 落库 variant=1 并建进度行 + 5 行 introduced', async () => {
  mode = 'ok'
  const res = await post('/api/challenge/v1/generate', {}, 11)
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.variant, 1)
  assert.equal(body.challenge.recall.length, 3)
  assert.equal(body.challenge.chunks.length, 5)
  assert.equal(body.progress.cursor, 0)
  assert.equal(body.progress.status, 'active')
  assert.equal(body.progress.steps.length, 5)
  assert.equal(body.mastery.introduced.length, 5)
  assert.equal(countRows('speaking_challenges', 'user_id=?', [11]), 1)
})

test('再生成一次 → variant=2，且 prompt 带上第 1 套的语块（avoid 生效）', async () => {
  mode = 'ok'
  const before = userPrompts.length
  const res = await post('/api/challenge/v1/generate', {}, 11)
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.variant, 2)
  const genPrompt = userPrompts.slice(before).find(p => p.sys.includes('五步口语挑战'))
  assert.ok(genPrompt, '应有生成 prompt')
  assert.ok(genPrompt.user.includes('check in'), 'avoid 清单应含第 1 套语块')
})

test('无字幕视频 → 503，不写库', async () => {
  mode = 'ok'
  const before = countRows('speaking_challenges', 'user_id=?', [12])
  const res = await post('/api/challenge/v2/generate', {}, 12)
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /字幕/)
  assert.equal(countRows('speaking_challenges', 'user_id=?', [12]), before)
})

test('AI 连续失败 → 503 且不写库', async () => {
  mode = 'fail'
  const before = countRows('speaking_challenges', 'user_id=?', [13])
  const res = await post('/api/challenge/v1/generate', {}, 13)
  assert.equal(res.status, 503)
  assert.equal(countRows('speaking_challenges', 'user_id=?', [13]), before)
  mode = 'ok'
})

test('非本人挑战 → 403', async () => {
  const row = get('SELECT id FROM speaking_challenges WHERE user_id=? ORDER BY variant LIMIT 1', [11])
  const res = await put(`/api/challenge/${row.id}/progress`, { cursor: 2 }, 99)
  assert.equal(res.status, 403)
})

test('PUT progress 更新 cursor，越界 400', async () => {
  const row = get('SELECT id FROM speaking_challenges WHERE user_id=? ORDER BY variant DESC LIMIT 1', [11])
  const ok = await put(`/api/challenge/${row.id}/progress`, { cursor: 3 }, 11)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).progress.cursor, 3)

  const bad = await put(`/api/challenge/${row.id}/progress`, { cursor: 9 }, 11)
  assert.equal(bad.status, 400)
})

test('restart 清空 steps/report/cursor，保留 challenge 与 mastery 行', async () => {
  const row = get('SELECT id FROM speaking_challenges WHERE user_id=? ORDER BY variant DESC LIMIT 1', [11])
  const before = countRows('chunk_mastery', 'user_id=?', [11])
  const res = await post(`/api/challenge/${row.id}/restart`, {}, 11)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.progress.cursor, 0)
  assert.equal(body.progress.status, 'active')
  assert.deepEqual(body.progress.steps, [null, null, null, null, null])
  assert.equal(body.progress.report, null)
  assert.equal(countRows('chunk_mastery', 'user_id=?', [11]), before)
  const still = get('SELECT challenge_json FROM speaking_challenges WHERE id=?', [row.id])
  assert.ok(JSON.parse(still.challenge_json).chunks.length === 5)
})

test('GET ?variant=1 返回旧版本而不是最新版', async () => {
  const latest = await (await getJson('/api/challenge/v1', 11)).json()
  assert.equal(latest.variant, 2)
  const old = await (await getJson('/api/challenge/v1?variant=1', 11)).json()
  assert.equal(old.variant, 1)
  assert.equal(old.progress.challengeId, old.challengeId)
})

test('challenge_json 损坏 → 500 且服务不崩', async () => {
  const row = get('SELECT id FROM speaking_challenges WHERE user_id=? ORDER BY variant LIMIT 1', [11])
  const { run } = require('../db.cjs')
  run('UPDATE speaking_challenges SET challenge_json=? WHERE id=?', ['{not json', row.id])
  const res = await put(`/api/challenge/${row.id}/progress`, { cursor: 1 }, 11)
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /损坏/)
  run('UPDATE speaking_challenges SET challenge_json=? WHERE id=?', [JSON.stringify(challengeRaw()), row.id])
})


// ─── Task 6：step 反馈 / chat / finish ─────────────────────
async function generateFor(userId) {
  mode = 'ok'
  const res = await post('/api/challenge/v1/generate', {}, userId)
  assert.equal(res.status, 201)
  return res.json()
}

async function step1(ch, userId, text = 'At the front desk they want to check in.') {
  return post(`/api/challenge/${ch.challengeId}/step/1`, {
    answers: [0, 1, 2].map(i => ({ index: i, text: `${text} (${i})`, durationMs: 12000, segments: 1 })),
  }, userId)
}

async function step2(ch, userId) {
  return post(`/api/challenge/${ch.challengeId}/step/2`, {
    answers: [0, 1, 2, 3, 4].map(i => ({ index: i, chunkText: `chunk ${i}`, sentence: `I used chunk ${i}.`, durationMs: 8000, segments: 1 })),
  }, userId)
}

async function step3(ch, userId) {
  return post(`/api/challenge/${ch.challengeId}/step/3`, {
    answers: [0, 1, 2, 3, 4].map(i => ({ index: i, text: `Situation ${i} answer.`, durationMs: 9000, segments: 1 })),
  }, userId)
}

async function step4(ch, userId) {
  return post(`/api/challenge/${ch.challengeId}/step/4`, { text: 'I once lost my luggage and it worked out.', durationMs: 75000, segments: 2 }, userId)
}

async function chatTimes(ch, userId, n) {
  for (let i = 0; i < n; i += 1) {
    const res = await post(`/api/challenge/${ch.challengeId}/chat`, { text: `My turn ${i + 1} about the trip.`, durationMs: 6000, segments: 1 }, userId)
    assert.equal(res.status, 200, `chat turn ${i + 1} failed`)
  }
}

test('step 越界 → 400', async () => {
  const ch = await generateFor(21)
  for (const step of [0, 5, 9]) {
    const res = await post(`/api/challenge/${ch.challengeId}/step/${step}`, { answers: [] }, 21)
    assert.equal(res.status, 400)
  }
})

test('step 1 答案不全 → 400 且 steps 未变', async () => {
  const ch = await generateFor(22)
  const res = await post(`/api/challenge/${ch.challengeId}/step/1`, {
    answers: [{ index: 0, text: 'only one' }],
  }, 22)
  assert.equal(res.status, 400)
  const after = await (await getJson('/api/challenge/v1', 22)).json()
  assert.deepEqual(after.progress.steps, [null, null, null, null, null])
})

test('step 1 正常 → 反馈 3 条，状态 completed', async () => {
  const ch = await generateFor(23)
  const res = await step1(ch, 23)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.feedback.items.length, 3)
  assert.equal(body.progress.steps[0].status, 'completed')
  assert.equal(body.progress.steps[0].feedback.score, 80)
})

test('step 2 重复提交同一步 → uses_count 不虚增', async () => {
  const ch = await generateFor(24)
  await step2(ch, 24)
  const body = await (await step2(ch, 24)).json()
  const row = body.mastery.selfUsed.find(r => r.chunkKey.includes('check in')) || body.mastery.selfUsed[0]
  assert.ok(row, '第一个语块应被标为 activated')
  assert.equal(row.usesCount, 1)
})

test('反馈 AI 失败 → 503 且答案已落库；重试成功', async () => {
  const ch = await generateFor(25)
  mode = 'fail'
  const fail = await step1(ch, 25)
  assert.equal(fail.status, 503)
  const failBody = await fail.json()
  assert.equal(failBody.hasAnswers, true)
  assert.equal(failBody.progress?.steps?.[0]?.status, 'answered', '503 也要把进度返回给前端')
  const mid = await (await getJson('/api/challenge/v1', 25)).json()
  assert.equal(mid.progress.steps[0].status, 'answered')
  assert.equal(mid.progress.steps[0].feedback, null)
  assert.equal(mid.progress.steps[0].answers.length, 3)

  mode = 'ok'
  const ok = await step1(ch, 25)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).progress.steps[0].status, 'completed')
})

test('step 4 无文字但有时长 → 200，不调 AI；太短 → 400', async () => {
  const ch = await generateFor(26)
  const before = calls.feedback
  const res = await post(`/api/challenge/${ch.challengeId}/step/4`, { text: '', durationMs: 6000, segments: 1 }, 26)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.feedback, null)
  assert.ok(body.note)
  assert.equal(calls.feedback, before, '不该调 AI')

  const bad = await post(`/api/challenge/${ch.challengeId}/step/4`, { text: '', durationMs: 1000 }, 26)
  assert.equal(bad.status, 400)
})

test('chat 首调取开场白，一轮后 userTurns=1', async () => {
  const ch = await generateFor(27)
  const open = await post(`/api/challenge/${ch.challengeId}/chat`, {}, 27)
  assert.equal(open.status, 200)
  const openBody = await open.json()
  assert.ok(openBody.reply)
  assert.equal(openBody.messages.length, 1)
  assert.equal(openBody.userTurns, 0)

  const turn = await post(`/api/challenge/${ch.challengeId}/chat`, { text: 'It was a small problem.', durationMs: 5000, segments: 1 }, 27)
  const turnBody = await turn.json()
  assert.equal(turnBody.userTurns, 1)
  assert.equal(turnBody.messages.length, 3)
  assert.equal(turnBody.canFinish, false)
})

test('chat 超过 8 轮 → 400', async () => {
  const ch = await generateFor(28)
  await post(`/api/challenge/${ch.challengeId}/chat`, {}, 28)
  await chatTimes(ch, 28, 8)
  const res = await post(`/api/challenge/${ch.challengeId}/chat`, { text: 'one more' }, 28)
  assert.equal(res.status, 400)
})

test('finish 前置：轮次不足或步骤未完成 → 400', async () => {
  const ch = await generateFor(29)
  const noTurns = await post(`/api/challenge/${ch.challengeId}/finish`, {}, 29)
  assert.equal(noTurns.status, 400)

  await step1(ch, 29); await step2(ch, 29)
  await post(`/api/challenge/${ch.challengeId}/chat`, {}, 29)
  await chatTimes(ch, 29, 5)
  const incomplete = await post(`/api/challenge/${ch.challengeId}/finish`, {}, 29)
  assert.equal(incomplete.status, 400)
  const incompleteMsg = (await incomplete.json()).error
  assert.match(incompleteMsg, /未完成/)
  assert.match(incompleteMsg, /第 3、4 步/)
})

test('finish 正常 → 报告含本地统计 + 四堆快照 + progress 完成', async () => {
  const ch = await generateFor(30)
  await step1(ch, 30); await step2(ch, 30); await step3(ch, 30); await step4(ch, 30)
  await post(`/api/challenge/${ch.challengeId}/chat`, {}, 30)
  await chatTimes(ch, 30, 5)
  const res = await post(`/api/challenge/${ch.challengeId}/finish`, {}, 30)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.report.score, 82)
  assert.ok(Array.isArray(body.report.nextSuggestions))
  assert.ok(body.report.speaking.longestSeconds >= 75)
  for (const key of ['mastered', 'selfUsed', 'review', 'introduced']) {
    assert.ok(Array.isArray(body.report[key]), `报告缺 ${key}`)
  }
  assert.equal(body.progress.status, 'completed')
  assert.equal(body.progress.cursor, 5)
  assert.equal(body.progress.steps[4].status, 'completed')
  assert.ok(body.report.mastered.some(r => r.chunkKey.includes('check in')),
    '对话里用好语块应把该语块标成 mastered')
  assert.ok(body.mastery.mastered.length >= 1)
})

test('旧版本报告不被新版本掌握状态污染（快照）', async () => {
  // 用户 31：第一套练完 → 某语块在 review 堆（反馈全部「没说对」）
  feedbackPayload = {
    score: 50,
    items: [{ index: 0, comment: '再试试' }],
    chunkUsage: [{ chunkId: 0, used: false, quality: 'wrong' }],
    praise: '敢开口',
  }
  finishChunkUsage = [{ chunkId: 0, used: false, quality: 'wrong' }]
  const first = await generateFor(31)
  await step1(first, 31); await step2(first, 31); await step3(first, 31); await step4(first, 31)
  await post(`/api/challenge/${first.challengeId}/chat`, {}, 31)
  await chatTimes(first, 31, 5)
  const done1 = await (await post(`/api/challenge/${first.challengeId}/finish`, {}, 31)).json()
  const reviewKey = done1.report.review[0] && done1.report.review[0].chunkKey
  assert.ok(reviewKey, '第一套应有需要复习的语块')

  // 第二套：同样语块练到 mastered
  feedbackPayload = null
  finishChunkUsage = null
  const second = await generateFor(31)
  await step1(second, 31); await step2(second, 31); await step3(second, 31)
  const s4 = await post(`/api/challenge/${second.challengeId}/step/4`, { text: 'A long story about the trip.', durationMs: 70000, segments: 2 }, 31)
  assert.equal(s4.status, 200)
  await post(`/api/challenge/${second.challengeId}/chat`, {}, 31)
  await chatTimes(second, 31, 5)
  const done2 = await (await post(`/api/challenge/${second.challengeId}/finish`, {}, 31)).json()
  assert.ok(done2.report.mastered.some(r => r.chunkKey === reviewKey), '第二套应把该语块练到 mastered')

  const old = await (await getJson('/api/challenge/v1?variant=1', 31)).json()
  assert.equal(old.progress.report.review.some(r => r.chunkKey === reviewKey), true, '旧报告快照不应被改写')
})

test('反馈里的越界 chunkId 不写脏掌握状态', async () => {
  const ch = await generateFor(32)
  const before = await (await getJson('/api/challenge/v1', 32)).json()
  feedbackPayload = {
    score: 70,
    items: [],
    chunkUsage: [{ chunkId: 77, used: true, quality: 'good' }],
    praise: 'ok',
  }
  const res = await step2(ch, 32)
  assert.equal(res.status, 200)
  const after = await (await getJson('/api/challenge/v1', 32)).json()
  assert.deepEqual(after.mastery.mastered.length, before.mastery.mastered.length)
  assert.deepEqual(after.mastery.selfUsed.length, before.mastery.selfUsed.length)
  assert.equal(after.mastery.introduced.length, 5)
  feedbackPayload = null
})
