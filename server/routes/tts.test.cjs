const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// TTS 路由测试：provider 置为 aliyun 且无凭据 → 未配置路径（不触发真实合成）
process.env.TTS_PROVIDER = 'aliyun'
delete process.env.ALIYUN_NLS_APP_KEY
delete process.env.ALIYUN_ACCESS_KEY_ID
delete process.env.ALIYUN_ACCESS_KEY_SECRET

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-tts-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const ttsRoutes = require('./tts.cjs')
const app = express()
app.use(express.json())
app.use('/api/tts', ttsRoutes.router)

let server, baseUrl
const authHeaders = () => ({ Authorization: `Bearer ${signToken(11)}`, 'Content-Type': 'application/json' })

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => { if (server) server.close() })

test('GET /status → provider=aliyun, configured=false（无凭据）', async () => {
  const res = await fetch(`${baseUrl}/api/tts/status`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.provider, 'aliyun')
  assert.equal(body.configured, false)
})

test('POST /synthesize 未配置 → 503', async () => {
  const res = await fetch(`${baseUrl}/api/tts/synthesize`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'hello' }),
  })
  assert.equal(res.status, 503)
})

test('游客（无 token）→ 401（TTS 端点必须鉴权，防免费语音代理滥用）', async () => {
  const res = await fetch(`${baseUrl}/api/tts/synthesize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
  })
  assert.equal(res.status, 401)
})

test('空文本 → 400', async () => {
  const res = await fetch(`${baseUrl}/api/tts/synthesize`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: '   ' }),
  })
  assert.equal(res.status, 400)
})

test('超长文本 → 400', async () => {
  const res = await fetch(`${baseUrl}/api/tts/synthesize`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'x'.repeat(2001) }),
  })
  assert.equal(res.status, 400)
})
