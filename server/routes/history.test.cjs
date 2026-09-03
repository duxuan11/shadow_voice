const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// 临时库，避免污染真实 data/shadow_voice.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-history-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb } = require('../db.cjs')
const { signToken } = require('../auth.cjs')

const historyRoutes = require('./history.cjs')
const app = express()
app.use(express.json())
app.use('/api/history', historyRoutes)

let server, baseUrl
const USER_ID = 7

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

test('游客访问 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/history`)
  assert.equal(res.status, 401)
})

test('空历史返回空数组', async () => {
  const res = await fetch(`${baseUrl}/api/history`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.history, [])
})

test('记录观看后可读取', async () => {
  await fetch(`${baseUrl}/api/history/v1`, { method: 'POST', headers: authHeaders() })
  const res = await fetch(`${baseUrl}/api/history`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual(body.history, ['v1'])
})

test('多个视频：最新观看在前', async () => {
  await fetch(`${baseUrl}/api/history/v2`, { method: 'POST', headers: authHeaders() })
  await fetch(`${baseUrl}/api/history/v3`, { method: 'POST', headers: authHeaders() })
  const res = await fetch(`${baseUrl}/api/history`, { headers: authHeaders() })
  const body = await res.json()
  assert.equal(body.history[0], 'v3')
  assert.deepEqual(new Set(body.history), new Set(['v1', 'v2', 'v3']))
})

test('重复观看同一视频 → 去重置顶', async () => {
  // 当前顺序 v3,v2,v1；重看 v1 → v1 应置顶
  await fetch(`${baseUrl}/api/history/v1`, { method: 'POST', headers: authHeaders() })
  const res = await fetch(`${baseUrl}/api/history`, { headers: authHeaders() })
  const body = await res.json()
  assert.equal(body.history[0], 'v1')
})

test('merge 保序：ids 最新在前，顺序一致', async () => {
  const ids = ['m1', 'm2', 'm3']
  const res = await fetch(`${baseUrl}/api/history/merge`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ ids })
  })
  assert.equal(res.status, 200)
  const list = await (await fetch(`${baseUrl}/api/history`, { headers: authHeaders() })).json()
  // 合并进来的 m1..m3 应排在本用户其他记录之前，且相对顺序保持 m1,m2,m3
  const merged = list.history.filter(id => ids.includes(id))
  assert.deepEqual(merged, ids)
})

test('超过 50 条修剪为 50', async () => {
  const ids = Array.from({ length: 55 }, (_, i) => `big-${i}`)
  await fetch(`${baseUrl}/api/history/merge`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ ids })
  })
  const res = await fetch(`${baseUrl}/api/history`, { headers: authHeaders() })
  const body = await res.json()
  assert.equal(body.history.length, 50)
  assert.equal(body.history[0], 'big-0')
})

test('DELETE 清空历史', async () => {
  await fetch(`${baseUrl}/api/history`, { method: 'DELETE', headers: authHeaders() })
  const res = await fetch(`${baseUrl}/api/history`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual(body.history, [])
})
