const test = require('node:test')
const assert = require('node:assert/strict')
// 测试封闭：清除 AI env（provider 模块加载时捕获 env），保证走「未配置」分支
delete process.env.AI_API_KEY
delete process.env.AI_BASE_URL
delete process.env.AI_MODEL

const express = require('express')
const { signToken } = require('../auth.cjs')
const speakRoutes = require('./speak.cjs')
const app = express()
app.use(express.json())
app.use('/api/speak', speakRoutes.router)

const { before, after } = require('node:test')
let server, baseUrl
before(async () => {
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

const headers = (token) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) })
const valid = { cn: '我们办理了入住。', en: 'We checked in.', userText: 'We check in.' }

test('游客 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers(), body: JSON.stringify(valid) })
  assert.equal(res.status, 401)
})
test('无效 token → 401', async () => {
  const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers('bad.token.x'), body: JSON.stringify(valid) })
  assert.equal(res.status, 401)
})
test('缺 cn/en/userText → 400', async () => {
  const tok = signToken(7)
  for (const body of [{ en: 'a', userText: 'b' }, { cn: 'a', userText: 'b' }, { cn: 'a', en: 'b' }, { cn: '', en: 'b', userText: 'c' }]) {
    const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers(tok), body: JSON.stringify(body) })
    assert.equal(res.status, 400)
  }
})
test('未配置 AI key → 503', async () => {
  const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers(signToken(7)), body: JSON.stringify(valid) })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /AI 未配置/)
})
