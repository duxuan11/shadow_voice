const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// ASR 路由测试：无凭据（未配置路径）+ stub fetch（配置成功路径）
delete process.env.ALIYUN_NLS_APP_KEY
delete process.env.ALIYUN_ACCESS_KEY_ID
delete process.env.ALIYUN_ACCESS_KEY_SECRET

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-asr-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const asrRoutes = require('./asr.cjs')
const app = express()
app.use(express.json())
app.use('/api/asr', asrRoutes.router)

let server, baseUrl
const authHeaders = () => ({ Authorization: `Bearer ${signToken(11)}` })

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => { if (server) server.close() })

test('GET /status 无凭据 → configured=false', async () => {
  const res = await fetch(`${baseUrl}/api/asr/status`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).configured, false)
})

test('POST /recognize 未配置 → 503', async () => {
  const pcm = Buffer.alloc(3200) // 0.1s 静音 16k
  const res = await fetch(`${baseUrl}/api/asr/recognize`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: pcm,
  })
  assert.equal(res.status, 503)
})

test('游客 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/asr/recognize`, { method: 'POST', body: Buffer.alloc(3200) })
  assert.equal(res.status, 401)
})

test('空 body → 400', async () => {
  const res = await fetch(`${baseUrl}/api/asr/recognize`, { method: 'POST', headers: authHeaders() })
  assert.equal(res.status, 400)
})

// 回归（2026-08-24）：authFetch 曾把 Blob 上传强制标 application/json → 全局
// express.json() 100KB 限制 → PayloadTooLargeError → 500。真实录音（>100KB）必须
// 以 octet-stream 到达 handler（未配置 → 503），绝不能再 413/500。
test('大 body（300KB PCM）→ 未配置 503，不被 JSON 解析器拦截', async () => {
  const pcm = Buffer.alloc(300 * 1024) // 300KB，远超 express.json() 默认 100KB
  const res = await fetch(`${baseUrl}/api/asr/recognize`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
    body: pcm,
  })
  assert.equal(res.status, 503)
})

// ── 配置成功路径（stub fetch：CreateToken + 一句话识别）──
test('已配置：recognize 返回识别文本（真实响应形状：result 为字符串）', async () => {
  process.env.ALIYUN_NLS_APP_KEY = 'test-appkey'
  process.env.ALIYUN_ACCESS_KEY_ID = 'test-ak-id'
  process.env.ALIYUN_ACCESS_KEY_SECRET = 'test-ak-secret'
  // 重新加载模块（env 在模块加载时读取）
  delete require.cache[require.resolve('../services/asr.cjs')]
  delete require.cache[require.resolve('../services/tts/aliyun.cjs')]
  // pop-core 不走 global.fetch（自带 HTTP 客户端）→ 直接 mock getToken
  const aliyunMod = require('../services/tts/aliyun.cjs')
  aliyunMod.getToken = async () => 'mock-token'
  const realFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('stream/v1/asr')) {
      // 实测 2026-08-25：一句话识别 REST 返回 {"status":20000000,"result":"hello world"}，
      // result 是字符串不是对象 —— 旧解析 data.result.text 恒为 undefined → 422 未识别到有效语音
      return { ok: true, json: async () => ({ status: 20000000, result: 'hello world' }) }
    }
    return realFetch(url, opts)
  }
  try {
    const asr = require('../services/asr.cjs')
    const text = await asr.recognize(Buffer.alloc(3200))
    assert.equal(text, 'hello world')
  } finally {
    global.fetch = realFetch
  }
})

test('已配置：兼容旧形状 result:{text}（防御性，不应回归）', async () => {
  const aliyunMod = require('../services/tts/aliyun.cjs')
  aliyunMod.getToken = async () => 'mock-token'
  const realFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('stream/v1/asr')) {
      return { ok: true, json: async () => ({ status: 20000000, result: { text: 'legacy text' } }) }
    }
    return realFetch(url, opts)
  }
  try {
    const asr = require('../services/asr.cjs')
    const text = await asr.recognize(Buffer.alloc(3200))
    assert.equal(text, 'legacy text')
  } finally {
    global.fetch = realFetch
  }
})
