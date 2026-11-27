const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-shadow-eval-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb, all, run } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const shadowEvalRoutes = require('./shadowEval.cjs')
const app = express()
app.use(express.json({ limit: '1mb' }))
app.use('/api/shadow-eval', shadowEvalRoutes.router)

let server, baseUrl
const auth = () => ({ Authorization: `Bearer ${signToken(11)}`, 'Content-Type': 'application/json' })
const body = (over = {}) => ({
  videoId: 'v1', subIndex: 3, refText: 'get out', accent: '美音', evalAccent: 'am',
  overall: 96, accuracy: 97, integrity: 100,
  params: { coreType: 'en.sent.score' },
  result: { result: { overall: 96 }, audioUrl: 'https://files.cloud.ssapi.cn/x.mp3' },
  diagnosis: { items: [] }, ...over,
})

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

test('未登录 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
  })
  assert.equal(res.status, 401)
})

test('正常写入 → 201，且 audioUrl 被剔除', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(), body: JSON.stringify(body()),
  })
  assert.equal(res.status, 201)
  const { id } = await res.json()
  const rows = all('SELECT result FROM shadow_eval_samples WHERE id = ?', [id])
  assert.equal(rows.length, 1)
  assert.ok(!rows[0].result.includes('audioUrl'), 'audioUrl 必须被剔除')
})

test('result 超过 64KB → 400', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify(body({ result: { blob: 'x'.repeat(70000) } })),
  })
  assert.equal(res.status, 400)
})

test('缺 refText → 400', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(), body: JSON.stringify(body({ refText: '' })),
  })
  assert.equal(res.status, 400)
})

test('30 天前的样本在写入后被清理', async () => {
  run("INSERT INTO shadow_eval_samples (user_id, ref_text, result, created_at) VALUES (?, ?, ?, datetime('now','-40 days'))",
    [11, 'old', '{}'])
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(), body: JSON.stringify(body()),
  })
  assert.equal(res.status, 201)
  const old = all('SELECT id FROM shadow_eval_samples WHERE ref_text = ?', ['old'])
  assert.equal(old.length, 0)
})

test('subIndex 为 null 也能写入（文本练习跟读不传句序）', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(), body: JSON.stringify(body({ subIndex: null })),
  })
  assert.equal(res.status, 201)
})
