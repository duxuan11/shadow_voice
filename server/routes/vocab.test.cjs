const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// 临时库，避免污染真实 data/shadow_voice.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-vocab-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb } = require('../db.cjs')
const { signToken } = require('../auth.cjs')

const vocabRoutes = require('./vocab.cjs')
const app = express()
app.use(express.json())
app.use('/api/vocab', vocabRoutes)

let server, baseUrl
const USER_ID = 7
const OTHER_USER = 8

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

async function add(body, userId = USER_ID) {
  const res = await fetch(`${baseUrl}/api/vocab`, {
    method: 'POST', headers: authHeaders(userId), body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function list(userId = USER_ID) {
  const res = await fetch(`${baseUrl}/api/vocab`, { headers: authHeaders(userId) })
  return { status: res.status, body: await res.json() }
}

async function practice(word, correct, userId = USER_ID) {
  const res = await fetch(`${baseUrl}/api/vocab/practice`, {
    method: 'POST', headers: authHeaders(userId), body: JSON.stringify({ word, correct }),
  })
  return { status: res.status, body: await res.json() }
}

test('游客访问 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/vocab`)
  assert.equal(res.status, 401)
})

test('空生词本返回空数组', async () => {
  const { status, body } = await list()
  assert.equal(status, 200)
  assert.deepEqual(body.vocabulary, [])
})

test('添加单词 → 返回统一模型字段', async () => {
  const { status, body } = await add({
    content: 'Experience', translation: '经验', type: 'word', phonetic: '/ɪkˈspɪɹiəns/',
    videoId: 'v1', videoTitle: 'Hotel Check-in',
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.entry.content, 'Experience')
  assert.equal(body.entry.word, 'experience')
  assert.equal(body.entry.translation, '经验')
  assert.equal(body.entry.type, 'word')
  assert.equal(body.entry.phonetic, '/ɪkˈspɪɹiəns/')
  assert.deepEqual(body.entry.sources, [{ videoId: 'v1', videoTitle: 'Hotel Check-in' }])
  assert.ok(body.entry.created_at)
})

test('去重：大小写/标点不同视为同一条', async () => {
  await add({ content: 'Check', translation: '检查', type: 'word', videoId: 'v1', videoTitle: 'A' })
  await add({ content: 'check', videoId: 'v1', videoTitle: 'A' })
  await add({ content: 'CHECK!', videoId: 'v1', videoTitle: 'A' })
  const { body } = await list()
  const matches = body.vocabulary.filter(v => v.word === 'check')
  assert.equal(matches.length, 1)
})

test('多视频来源：合并 sources 且不重复', async () => {
  await add({ content: 'downtown', type: 'word', videoId: 'v2', videoTitle: 'Business Travel' })
  await add({ content: 'downtown', type: 'word', videoId: 'v3', videoTitle: 'Airport English' })
  await add({ content: 'downtown', type: 'word', videoId: 'v2', videoTitle: 'Business Travel' })
  const { body } = await list()
  const entry = body.vocabulary.find(v => v.word === 'downtown')
  assert.equal(entry.sources.length, 2)
  assert.deepEqual(entry.sources.map(s => s.videoId).sort(), ['v2', 'v3'])
})

test('重复添加补齐缺失的翻译/音标，不覆盖已有值', async () => {
  await add({ content: 'resilient', type: 'word', videoId: 'v4', videoTitle: 'X' })
  await add({ content: 'resilient', translation: '有韧性的', phonetic: '/rɪˈzɪliənt/', type: 'word', videoId: 'v4', videoTitle: 'X' })
  const { body } = await list()
  const entry = body.vocabulary.find(v => v.word === 'resilient')
  assert.equal(entry.translation, '有韧性的')
  assert.equal(entry.phonetic, '/rɪˈzɪliənt/')

  await add({ content: 'resilient', translation: '不应覆盖', type: 'word', videoId: 'v4', videoTitle: 'X' })
  const { body: body2 } = await list()
  assert.equal(body2.vocabulary.find(v => v.word === 'resilient').translation, '有韧性的')
})

test('短语：类型与空格 key 正常', async () => {
  const { body } = await add({
    content: 'check in', translation: '办理入住', type: 'phrase', videoId: 'v1', videoTitle: 'Hotel Check-in',
  })
  assert.equal(body.entry.word, 'check in')
  assert.equal(body.entry.type, 'phrase')
  assert.equal(body.entry.sources[0].videoTitle, 'Hotel Check-in')
})

test('核心短语：type=core_phrase', async () => {
  const { body } = await add({
    content: 'It turns out that ...', translation: '结果……', type: 'core_phrase', videoId: 'v5', videoTitle: 'Interview',
  })
  assert.equal(body.entry.type, 'core_phrase')
  assert.equal(body.entry.word, 'it turns out that')
})

test('非法 type 回退为 word', async () => {
  const { body } = await add({ content: 'fallbacktype', type: 'nonsense', videoId: 'v1', videoTitle: 'A' })
  assert.equal(body.entry.type, 'word')
})

test('旧接口兼容：body.word', async () => {
  const { body } = await add({ word: 'Legacy', videoId: 'v9', videoTitle: 'Old' })
  assert.equal(body.entry.word, 'legacy')
  assert.equal(body.entry.content, 'Legacy')
})

test('按规范化 key 删除（含空格短语）', async () => {
  await add({ content: 'for now', translation: '暂时', type: 'phrase', videoId: 'v6', videoTitle: 'Y' })
  const before = await list()
  assert.ok(before.body.vocabulary.some(v => v.word === 'for now'))

  const res = await fetch(`${baseUrl}/api/vocab/${encodeURIComponent('for now')}`, {
    method: 'DELETE', headers: authHeaders(),
  })
  assert.equal(res.status, 200)
  const after = await list()
  assert.ok(!after.body.vocabulary.some(v => v.word === 'for now'))
})

test('多用户隔离：互不可见', async () => {
  await add({ content: 'privateword', type: 'word', videoId: 'v7', videoTitle: 'P' }, OTHER_USER)
  const { body } = await list(USER_ID)
  assert.ok(!body.vocabulary.some(v => v.word === 'privateword'))
  const other = await list(OTHER_USER)
  assert.equal(other.body.vocabulary.length, 1)
})

test('听练：首次正确 → practice_count=1 / correct_count=1 / last_practiced_at', async () => {
  await add({ content: 'practice-ok', type: 'word', videoId: 'p1', videoTitle: 'P' })
  const { status, body } = await practice('practice-ok', true)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.entry.practice_count, 1)
  assert.equal(body.entry.correct_count, 1)
  assert.ok(body.entry.last_practiced_at)
})

test('听练：累计正确与错误次数', async () => {
  await add({ content: 'practice-count', type: 'word', videoId: 'p1', videoTitle: 'P' })
  await practice('practice-count', true)
  await practice('practice-count', true)
  await practice('practice-count', false)
  const { body } = await list()
  const entry = body.vocabulary.find(v => v.word === 'practice count')
  assert.equal(entry.practice_count, 3)
  assert.equal(entry.correct_count, 2)
})

test('听练：未收录单词 → 404', async () => {
  const { status } = await practice('not-in-book', true)
  assert.equal(status, 404)
})

test('听练：correct 非布尔 → 400', async () => {
  await add({ content: 'practice-bad', type: 'word', videoId: 'p1', videoTitle: 'P' })
  const { status } = await practice('practice-bad', 'yes')
  assert.equal(status, 400)
})

test('听练：游客 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/vocab/practice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: 'practice-ok', correct: true }),
  })
  assert.equal(res.status, 401)
})

test('听练：多用户隔离（只统计本人）', async () => {
  // 'privateword' 在上方「多用户隔离」测试中已加入 OTHER_USER
  await practice('privateword', true, OTHER_USER)
  const mine = await list(USER_ID)
  assert.ok(!mine.body.vocabulary.some(v => v.word === 'privateword'))
  const other = await list(OTHER_USER)
  assert.equal(other.body.vocabulary.find(v => v.word === 'privateword').practice_count, 1)
})
