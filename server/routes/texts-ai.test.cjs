// 文本练习「有 AI」的路径：stub 掉 chat/completions，全程不调真实接口。
// 覆盖：批量翻译 ok/partial/unavailable、跟读评分 best、回译评分与 reveal、进度与改名语义。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

process.env.AI_API_KEY = 'test-key-for-unit-tests'
process.env.AI_BASE_URL = 'https://mock.invalid/v1'
process.env.AI_MODEL = 'mock-model'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-texts-ai-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

let translateMode = 'ok' // 'ok' | 'partial' | 'fail'
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes('/chat/completions')) return realFetch(url, opts)
  const body = JSON.parse(opts.body)
  const system = body.messages[0].content
  const user = body.messages.at(-1).content
  if (translateMode === 'fail') return { ok: false, status: 500, text: async () => 'boom' }
  if (system.includes('译者') || user.includes('i 从 0 开始')) {
    const idx = [...user.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]))
    const items = idx.map(i => ({ i, cn: `中文${i}` }))
    if (translateMode === 'partial') items.splice(1)
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }] }) }
  }
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      verdict: 'minor', score: 78,
      issues: [{ type: 'term', location: 'Unet', problem: '术语被改写', suggestion: '写回 U-Net', better: 'U-Net' }],
      better: 'U-Net has an encoder and a decoder.', praise: '意思对', lowScoreHint: '',
    }) } }] }),
  }
}

const express = require('express')
const { getDb } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const textsRoutes = require('./texts.cjs')
const app = express()
app.use(express.json())
app.use('/api/texts', textsRoutes.router)

let server, baseUrl
const USER_ID = 7, OTHER = 8
const SAMPLE = '# U-Net\n\nU-Net has an encoder and a decoder. PaCMAP preserves structure.'

const H = (u = USER_ID) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${signToken(u)}` })
const api = async (method, p, body, u = USER_ID) => {
  const res = await fetch(`${baseUrl}/api/texts${p}`, { method, headers: H(u), ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

let docId
before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  docId = (await api('POST', '', { title: 'T', text: SAMPLE })).body.doc.id
})
after(() => { if (server) server.close() })

test('保存时翻译成功 → translation=ok 且 cn 落库', async () => {
  const created = await api('POST', '', { title: 'ok', text: SAMPLE })
  assert.equal(created.status, 201)
  assert.equal(created.body.translation, 'ok')
  assert.deepEqual(created.body.doc.sentences.map(s => s.cn), ['中文0', '中文1'])
  assert.equal(created.body.doc.cnReady, true)
  assert.equal(created.body.doc.missingCn, 0)
})

test('翻译部分失败 → partial，缺的中文可再次补齐', async () => {
  translateMode = 'partial'
  const created = await api('POST', '', { title: 'p', text: SAMPLE })
  assert.equal(created.body.translation, 'partial')
  assert.equal(created.body.doc.sentences[1].cn, '')
  translateMode = 'ok'
  const fixed = await api('POST', `/${created.body.doc.id}/translate`)
  assert.equal(fixed.status, 200)
  assert.equal(fixed.body.translation, 'ok')
  assert.ok(fixed.body.doc.sentences.every(s => s.cn), '补齐后每句都应有中文')
})

test('翻译全部失败 → unavailable，但文本仍然保存成功', async () => {
  translateMode = 'fail'
  const created = await api('POST', '', { title: 'f', text: SAMPLE })
  assert.equal(created.status, 201)
  assert.equal(created.body.translation, 'unavailable')
  assert.equal(created.body.doc.sentences.length, 2)
  translateMode = 'ok'
})

test('跟读评分：best 取历史最高，attempts 累加', async () => {
  let r = await api('POST', `/${docId}/shadow`, { index: 0, score: 82 })
  assert.equal(r.status, 200)
  assert.deepEqual(
    r.body.progress.shadow.map(s => ({ index: s.index, best: s.best, attempts: s.attempts })),
    [{ index: 0, best: 82, attempts: 1 }],
  )
  r = await api('POST', `/${docId}/shadow`, { index: 0, score: 91 })
  assert.equal(r.body.progress.shadow[0].best, 91)
  assert.equal(r.body.progress.shadow[0].attempts, 2)
  r = await api('POST', `/${docId}/shadow`, { index: 0, score: 60 })
  assert.equal(r.body.progress.shadow[0].best, 91)
  assert.equal(r.body.progress.shadow[0].attempts, 3)
})

test('跟读评分入参校验', async () => {
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 0, score: 101 })).status, 400)
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 0, score: 'abc' })).status, 400)
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 99, score: 80 })).status, 400)
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 0, score: 80 }, OTHER)).status, 403)
})

test('回译评分：写入作答记录，第二次 attempts 递增', async () => {
  let r = await api('POST', `/${docId}/review`, { index: 1, userText: 'Unet has encoder and decoder.' })
  assert.equal(r.status, 200)
  assert.equal(r.body.review.verdict, 'minor')
  assert.equal(r.body.review.score, 78)
  assert.equal(r.body.attempts, 1)
  assert.equal(r.body.progress.answers[0].index, 1)
  assert.equal(r.body.progress.answers[0].revealedAnswer, false)
  r = await api('POST', `/${docId}/review`, { index: 1, userText: 'U-Net has an encoder and a decoder.' })
  assert.equal(r.body.attempts, 2)
  assert.equal(r.body.progress.answers.length, 1)
})

test('回译评分入参校验', async () => {
  assert.equal((await api('POST', `/${docId}/review`, { index: 1, userText: '   ' })).status, 400)
  assert.equal((await api('POST', `/${docId}/review`, { index: 1, userText: 'x'.repeat(1001) })).status, 400)
  assert.equal((await api('POST', `/${docId}/review`, { index: 42, userText: 'hi' })).status, 400)
})

test('reveal：未作答不造假，已作答置 revealedAnswer', async () => {
  const fresh = (await api('POST', '', { title: 'fresh', text: SAMPLE })).body.doc.id
  const before = await api('POST', `/${fresh}/reveal`, { index: 0 })
  assert.equal(before.status, 200)
  assert.equal(before.body.progress.answers.length, 0)

  await api('POST', `/${fresh}/review`, { index: 0, userText: 'Unet.' })
  const shown = await api('POST', `/${fresh}/reveal`, { index: 0 })
  assert.equal(shown.body.progress.answers[0].revealedAnswer, true)
})

test('进度：部分更新、cursor=total 合法、越界与非法状态', async () => {
  const fresh = (await api('POST', '', { title: 'progress', text: SAMPLE })).body.doc.id
  let r = await api('PUT', `/${fresh}/progress`, { shadowCursor: 2 })
  assert.equal(r.body.progress.shadowCursor, 2)
  assert.equal(r.body.progress.translateCursor, 0)
  r = await api('PUT', `/${fresh}/progress`, { translateCursor: 1 })
  assert.equal(r.body.progress.shadowCursor, 2)
  assert.equal(r.body.progress.translateCursor, 1)
  r = await api('PUT', `/${fresh}/progress`, { status: 'completed' })
  assert.equal(r.body.progress.status, 'completed')
  r = await api('PUT', `/${fresh}/progress`, { translateCursor: 3 })
  assert.equal(r.status, 400)
  assert.equal((await api('PUT', `/${fresh}/progress`, { status: 'weird' })).status, 400)
  assert.equal((await api('PUT', `/${fresh}/progress`, { shadowCursor: -1 })).status, 400)
})

test('改名保留进度；改正文才清空进度', async () => {
  const fresh = (await api('POST', '', { title: 'rename', text: SAMPLE })).body.doc.id
  await api('POST', `/${fresh}/shadow`, { index: 0, score: 88 })
  await api('POST', `/${fresh}/review`, { index: 1, userText: 'Unet.' })
  await api('PUT', `/${fresh}/progress`, { shadowCursor: 2, translateCursor: 1 })

  const renamed = await api('PUT', `/${fresh}`, { title: '新标题' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.doc.title, '新标题')
  assert.equal(renamed.body.progress.shadowCursor, 2)
  assert.equal(renamed.body.progress.translateCursor, 1)
  assert.equal(renamed.body.progress.shadow.length, 1)
  assert.equal(renamed.body.progress.answers.length, 1)

  const rewritten = await api('PUT', `/${fresh}`, { text: 'One brand new sentence here.' })
  assert.equal(rewritten.body.progress.shadowCursor, 0)
  assert.equal(rewritten.body.progress.translateCursor, 0)
  assert.equal(rewritten.body.progress.shadow.length, 0)
  assert.equal(rewritten.body.progress.answers.length, 0)
})

test('PUT 传相同的正文不清空进度', async () => {
  const fresh = (await api('POST', '', { title: 'same-body', text: SAMPLE })).body.doc.id
  await api('POST', `/${fresh}/shadow`, { index: 0, score: 90 })
  await api('POST', `/${fresh}/review`, { index: 1, userText: 'Unet.' })
  await api('PUT', `/${fresh}/progress`, { shadowCursor: 2, translateCursor: 1 })

  const same = await api('PUT', `/${fresh}`, { title: '只改标题', text: SAMPLE })
  assert.equal(same.status, 200)
  assert.equal(same.body.doc.title, '只改标题')
  assert.equal(same.body.progress.shadowCursor, 2)
  assert.equal(same.body.progress.translateCursor, 1)
  assert.equal(same.body.progress.shadow.length, 1)
  assert.equal(same.body.progress.answers.length, 1)
  assert.equal(same.body.doc.sentences[0].cn, '中文0')
})

test('分批翻译时前一批成功就先落库（中断也不全丢）', async () => {
  const many = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
  // 第二批开始失败：只让第一批成功
  let calls = 0
  const stub = global.fetch
  global.fetch = async (url, opts = {}) => {
    if (!String(url).includes('/chat/completions')) return stub(url, opts)
    calls++
    if (calls > 1) return { ok: false, status: 500, text: async () => 'boom' }
    return stub(url, opts)
  }
  const created = await api('POST', '', { title: 'chunked', text: many })
  global.fetch = stub
  assert.equal(created.status, 201)
  assert.equal(created.body.translation, 'partial')
  const cnFilled = created.body.doc.sentences.filter(s => s.cn).length
  assert.equal(cnFilled, 50, `第一批应已落库，实际 ${cnFilled}`)
})
