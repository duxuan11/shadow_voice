const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// 临时库，避免污染真实 data/shadow_voice.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-practice-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb, run } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const practiceRoutes = require('./practice.cjs')

const app = express()
app.use(express.json())
app.use('/api/practice', practiceRoutes)

let server, baseUrl
const USER_ID = 7
const OTHER_ID = 8

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => { if (server) server.close() })

function authHeaders(userId = USER_ID) {
  return { Authorization: `Bearer ${signToken(userId)}`, 'Content-Type': 'application/json' }
}

function post(videoId, body, userId = USER_ID) {
  return fetch(`${baseUrl}/api/practice/${videoId}`, {
    method: 'POST', headers: authHeaders(userId), body: JSON.stringify(body),
  })
}

test('游客访问 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/practice/summary`)
  assert.equal(res.status, 401)
})

test('无记录 GET 返回空数组', async () => {
  const res = await fetch(`${baseUrl}/api/practice/v-empty`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.data, { shadow: [], cloze: [], translate: [] })
})

test('POST 后 GET 可读', async () => {
  const res = await post('v1', { task: 'shadow', index: 2 })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.data.shadow, [2])

  const get = await fetch(`${baseUrl}/api/practice/v1`, { headers: authHeaders() })
  const got = await get.json()
  assert.deepEqual(got.data.shadow, [2])
})

test('重复 POST 幂等（同句只记一次）', async () => {
  await post('v2', { task: 'cloze', index: 5 })
  await post('v2', { task: 'cloze', index: 5 })
  await post('v2', { task: 'cloze', index: 1 })
  const res = await fetch(`${baseUrl}/api/practice/v2`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual([...body.data.cloze].sort((a, b) => a - b), [1, 5])
})

test('summary 返回各视频三项计数', async () => {
  await post('v3', { task: 'shadow', index: 0 })
  await post('v3', { task: 'shadow', index: 1 })
  await post('v3', { task: 'translate', index: 4 })
  const res = await fetch(`${baseUrl}/api/practice/summary`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual(body.summary.v3, { shadow: 2, cloze: 0, translate: 1 })
})

test('非法 task → 400', async () => {
  const res = await post('v4', { task: 'hack', index: 0 })
  assert.equal(res.status, 400)
})

test('负 index / 非整数 → 400', async () => {
  assert.equal((await post('v4', { task: 'shadow', index: -1 })).status, 400)
  assert.equal((await post('v4', { task: 'shadow', index: 1.5 })).status, 400)
  assert.equal((await post('v4', { task: 'shadow', index: '0' })).status, 400)
})

test('跨用户隔离', async () => {
  await post('v5', { task: 'shadow', index: 0 }, OTHER_ID)
  const res = await fetch(`${baseUrl}/api/practice/v5`, { headers: authHeaders(USER_ID) })
  const body = await res.json()
  assert.deepEqual(body.data.shadow, [])
})

test('损坏 JSON 容错为空', async () => {
  await getDb()
  run('INSERT INTO practice_records (user_id, video_id, data) VALUES (?, ?, ?)', [USER_ID, 'v-corrupt', '{bad json'])
  const res = await fetch(`${baseUrl}/api/practice/v-corrupt`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual(body.data, { shadow: [], cloze: [], translate: [] })
})
