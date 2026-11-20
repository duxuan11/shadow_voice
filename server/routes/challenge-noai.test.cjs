const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// AI 未配置环境：必须在 require 之前清空 key（provider.cjs 在模块加载时读取）
delete process.env.AI_API_KEY
process.env.AI_BASE_URL = 'https://mock.invalid/v1'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-challenge-noai-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const DATA_TMP = path.join(tmpDir, 'data')
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'ep1'), { recursive: true })
fs.writeFileSync(path.join(DATA_TMP, 'consolidated.json'), JSON.stringify([
  { id: 'v1', episode_dir: 'ep1', title: '出国旅行的日常', level: '中级' },
]))
fs.writeFileSync(path.join(DATA_TMP, 'videos', 'ep1', 'subtitles.json'), JSON.stringify([
  { textEn: "We'd like to check in, please.", textCn: '我们想办理入住。' },
]))
process.env.SHADOW_VOICE_DATA_DIR = DATA_TMP

const express = require('express')
const { getDb, run } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const challengeRoutes = require('./challenge.cjs')

const app = express()
app.use(express.json())
app.use('/api/challenge', challengeRoutes.router)

let server
let baseUrl

test.before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise((res) => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(() => { if (server) server.close() })

function headers(userId = 1) {
  return { Authorization: `Bearer ${signToken(userId)}`, 'Content-Type': 'application/json' }
}

function makeChallenge() {
  return {
    version: 1,
    title: '酒店入住',
    topicEn: 'hotel',
    topicCn: '酒店入住',
    source: 'subtitle',
    recall: [0, 1, 2].map((i) => ({ id: i, qEn: 'What happens at the desk?', qCn: '前台发生了什么？', focusCn: '办理入住' })),
    chunks: [0, 1, 2, 3, 4].map((i) => ({ id: i, en: `chunk ${i}`, cn: `语块${i}`, evidence: "We'd like to check in, please.", usageCn: '造句' })),
    transformations: [0, 1, 2, 3, 4].map((i) => ({ id: i, situationCn: `情境${i}：提出请求。`, targetChunkId: i, hintCn: '提示' })),
    topicSpeaking: { promptEn: 'Describe the trip.', promptCn: '讲讲这次旅行。', pointsCn: ['发生了什么'], targetSeconds: 90 },
  }
}

test('AI 未配置：GET 报告 aiConfigured:false，generate 503', async () => {
  const get1 = await fetch(`${baseUrl}/api/challenge/v1`, { headers: headers(7) })
  assert.equal(get1.status, 200)
  assert.equal((await get1.json()).aiConfigured, false)

  const gen = await fetch(`${baseUrl}/api/challenge/v1/generate`, {
    method: 'POST', headers: headers(7), body: JSON.stringify({}),
  })
  assert.equal(gen.status, 503)
  assert.match((await gen.json()).error, /未配置/)
})

test('AI 未配置：step 503 但答案先落库（hasAnswers:true）', async () => {
  await getDb()
  const r = run(
    'INSERT INTO speaking_challenges (user_id, video_id, variant, challenge_json) VALUES (?,?,?,?)',
    [8, 'v1', 1, JSON.stringify(makeChallenge())]
  )
  const id = r.lastInsertRowid

  const res = await fetch(`${baseUrl}/api/challenge/${id}/step/1`, {
    method: 'POST',
    headers: headers(8),
    body: JSON.stringify({ answers: [0, 1, 2].map((i) => ({ index: i, text: `answer ${i}`, durationMs: 9000, segments: 1 })) }),
  })
  assert.equal(res.status, 503)
  assert.equal((await res.json()).hasAnswers, true)

  const hub = await (await fetch(`${baseUrl}/api/challenge/v1`, { headers: headers(8) })).json()
  assert.equal(hub.progress.steps[0].status, 'answered')
  assert.equal(hub.progress.steps[0].feedback, null)
  assert.equal(hub.progress.steps[0].answers.length, 3)
})

test('AI 未配置：chat 503', async () => {
  const hub = await (await fetch(`${baseUrl}/api/challenge/v1`, { headers: headers(8) })).json()
  const res = await fetch(`${baseUrl}/api/challenge/${hub.challengeId}/chat`, {
    method: 'POST', headers: headers(8), body: JSON.stringify({}),
  })
  assert.equal(res.status, 503)
})
