const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-vocabctx-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const { getDb, run } = require('../db.cjs')
const { findContextCn, backfillVocabContext } = require('./vocabContext.cjs')

test('findContextCn：按词边界命中，大小写不敏感，返回该句 textCn', () => {
  const subs = [
    { textEn: 'I want to check in now', textCn: '我现在想办理入住' },
    { textEn: 'Passport, please.', textCn: '请出示护照。' },
  ]
  assert.equal(findContextCn('check in', subs), '我现在想办理入住')
  assert.equal(findContextCn('PASSPORT', subs), '请出示护照。')
})

test('findContextCn：未命中/空输入返回空串', () => {
  assert.equal(findContextCn('zzz', [{ textEn: 'hello', textCn: '你好' }]), '')
  assert.equal(findContextCn('', [{ textEn: 'hello', textCn: '你好' }]), '')
  assert.equal(findContextCn('cat', null), '')
  assert.equal(findContextCn('cat', [{ textEn: 'concatenate', textCn: '拼接' }]), '')
})

test('backfillVocabContext：为缺中文的生词补 context_cn', async () => {
  const db = await getDb()
  db.run("INSERT INTO users (id, username, email, password) VALUES (1, 'u', 'u@e.com', 'p')")
  db.run(`INSERT INTO vocabulary (user_id, word, content, type, sources, video_id)
          VALUES (1, 'passport', 'Passport', 'word', ?, 'v1')`, [JSON.stringify([{ videoId: 'v1' }])])
  db.run(`INSERT INTO vocabulary (user_id, word, content, translation, type, sources, video_id)
          VALUES (1, 'check in', 'check in', '办理入住', 'phrase', ?, 'v1')`, [JSON.stringify([{ videoId: 'v1' }])])

  fs.writeFileSync(path.join(tmpDir, 'consolidated.json'), JSON.stringify([{ id: 'v1', episode_dir: 'ep1' }]))
  fs.mkdirSync(path.join(tmpDir, 'videos', 'ep1'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'videos', 'ep1', 'subtitles.json'),
    JSON.stringify([{ textEn: 'Here is my passport.', textCn: '这是我的护照。' }]))

  const { filled } = await backfillVocabContext(tmpDir)
  assert.equal(filled, 1)
  const row = db.exec("SELECT context_cn FROM vocabulary WHERE word = 'passport'")[0].values[0][0]
  assert.equal(row, '这是我的护照。')
  // 已有 translation 的条目不回填
  const kept = db.exec("SELECT context_cn FROM vocabulary WHERE word = 'check in'")[0].values[0][0]
  assert.ok(kept == null || kept === '')

  // 幂等：再次回填不应重复写入
  const second = await backfillVocabContext(tmpDir)
  assert.equal(second.filled, 0)
  const still = db.exec("SELECT context_cn FROM vocabulary WHERE word = 'passport'")[0].values[0][0]
  assert.equal(still, '这是我的护照。')
})
