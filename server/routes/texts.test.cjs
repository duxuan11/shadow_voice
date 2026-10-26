const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

delete process.env.AI_API_KEY
delete process.env.AI_BASE_URL
delete process.env.AI_MODEL

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-texts-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb, get } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const textsRoutes = require('./texts.cjs')

const app = express()
app.use(express.json())
app.use('/api/texts', textsRoutes.router)

let server, baseUrl
const USER_ID = 7, OTHER = 8
const SAMPLE = '# U-Net\n\nU-Net has an encoder and a decoder. PaCMAP preserves structure.'

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

const H = (u = USER_ID) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${signToken(u)}` })
const api = async (method, p, body, u = USER_ID) => {
  const res = await fetch(`${baseUrl}/api/texts${p}`, { method, headers: H(u), ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const create = (body = { title: 'U-Net 摘要', text: SAMPLE }, u = USER_ID) => api('POST', '', body, u)

test('未登录 → 401', async () => {
  for (const [m, p] of [['GET', ''], ['POST', ''], ['GET', '/1'], ['PUT', '/1'], ['DELETE', '/1'], ['POST', '/1/translate']]) {
    const res = await fetch(`${baseUrl}/api/texts${p}`, { method: m, headers: { 'Content-Type': 'application/json' } })
    assert.equal(res.status, 401, `${m} ${p}`)
  }
})

test('标题/正文校验', async () => {
  assert.equal((await create({ title: '', text: SAMPLE })).status, 400)
  assert.equal((await create({ title: 'x'.repeat(101), text: SAMPLE })).status, 400)
  assert.equal((await create({ title: 'ok', text: '' })).status, 400)
  assert.equal((await create({ title: 'ok', text: 'x'.repeat(20001) })).status, 400)
  const noEn = await create({ title: 'ok', text: '```py\nprint(1)\n```' })
  assert.equal(noEn.status, 400)
  assert.match(noEn.body.error, /没有找到可练习的英文句子/)
})

test('保存 → 列表 → 详情（AI 未配置时 translation=unavailable）', async () => {
  const { status, body } = await create()
  assert.equal(status, 201)
  assert.equal(body.translation, 'unavailable')
  assert.equal(body.doc.sentences.length, 2)
  assert.deepEqual(body.doc.sentences.map(s => s.en), ['U-Net has an encoder and a decoder.', 'PaCMAP preserves structure.'])
  assert.deepEqual(body.doc.sentences.map(s => s.cn), ['', ''])
  assert.equal(body.doc.cnReady, false)
  assert.equal(body.doc.missingCn, 2)
  assert.equal(body.progress.shadowCursor, 0)
  assert.equal(body.progress.status, 'active')

  const list = await api('GET', '')
  const summary = list.body.docs.find(d => d.id === body.doc.id)
  assert.deepEqual(
    { title: summary.title, sentenceCount: summary.sentenceCount, cnReady: summary.cnReady, shadowDone: summary.shadowDone, translateDone: summary.translateDone, status: summary.status },
    { title: 'U-Net 摘要', sentenceCount: 2, cnReady: false, shadowDone: 0, translateDone: 0, status: 'active' },
  )

  const detail = await api('GET', `/${body.doc.id}`)
  assert.equal(detail.body.doc.sourceText, SAMPLE)
  assert.equal(detail.body.doc.sentences[0].section, 'U-Net')
  assert.equal(detail.body.aiConfigured, false)
})

test('详情：不存在 404、他人 403', async () => {
  const id = (await create()).body.doc.id
  assert.equal((await api('GET', '/9999')).status, 404)
  assert.equal((await api('GET', `/${id}`, null, OTHER)).status, 403)
})

test('只改标题不重切句', async () => {
  const created = (await create()).body
  const renamed = await api('PUT', `/${created.doc.id}`, { title: '新标题' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.doc.title, '新标题')
  assert.equal(renamed.body.doc.sentences.length, 2)
  assert.deepEqual(renamed.body.doc.sentences.map(s => s.en), created.doc.sentences.map(s => s.en))
  assert.equal(renamed.body.progress.shadowCursor, 0)
})

test('改正文 → 重切句且进度归零', async () => {
  const created = (await create()).body
  const rewritten = await api('PUT', `/${created.doc.id}`, { text: 'One brand new sentence here.' })
  assert.equal(rewritten.status, 200)
  assert.equal(rewritten.body.doc.sentences.length, 1)
  assert.equal(rewritten.body.progress.shadowCursor, 0)
  assert.equal(rewritten.body.progress.translateCursor, 0)
  assert.equal(rewritten.body.progress.status, 'active')
  assert.equal(rewritten.body.progress.shadow.length, 0)
  assert.equal(rewritten.body.progress.answers.length, 0)
})

test('删除 → 204，文档与进度行都没了', async () => {
  const id = (await create()).body.doc.id
  assert.equal((await api('DELETE', `/${id}`)).status, 204)
  assert.equal((await api('GET', `/${id}`)).status, 404)
  assert.equal(get('SELECT id FROM text_progress WHERE doc_id=?', [id]), undefined)
})

test('translate：AI 未配置 → 503', async () => {
  const id = (await create()).body.doc.id
  const res = await api('POST', `/${id}/translate`)
  assert.equal(res.status, 503)
  assert.match(res.body.error, /AI 未配置/)
})
