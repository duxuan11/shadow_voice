const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-chunk-mastery-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const cm = require('./chunkMastery.cjs')
const db = require('../db.cjs')

test('normalizeChunkKey 去掉省略号、标点与大小写差异', () => {
  assert.equal(cm.normalizeChunkKey('It turns out that...'), 'it turns out that')
  assert.equal(cm.normalizeChunkKey('  check   IN! '), 'check in')
  assert.equal(cm.normalizeChunkKey(''), '')
})

test('nextStatus 覆盖六条迁移规则且 mastered 为终态', () => {
  assert.equal(cm.nextStatus('introduced', { step: 2, used: true, quality: 'good' }), 'activated')
  assert.equal(cm.nextStatus('introduced', { step: 2, used: false, quality: 'wrong' }), 'review')
  assert.equal(cm.nextStatus('review', { step: 3, used: true, quality: 'good' }), 'activated')
  assert.equal(cm.nextStatus('activated', { step: 3, used: false, quality: 'partial' }), 'review')
  assert.equal(cm.nextStatus('activated', { step: 4, used: true, quality: 'good' }), 'mastered')
  assert.equal(cm.nextStatus('activated', { step: 5, used: false, quality: 'wrong' }), 'activated')
  assert.equal(cm.nextStatus('mastered', { step: 2, used: false, quality: 'wrong' }), 'mastered')
})

test('countsAsUse 只认「用了且用得好」', () => {
  assert.equal(cm.countsAsUse({ used: true, quality: 'good' }), true)
  assert.equal(cm.countsAsUse({ used: true, quality: 'partial' }), false)
  assert.equal(cm.countsAsUse({ used: false, quality: 'good' }), false)
})

test('upsertIntroduced 幂等，重复生成不产生多行', async () => {
  await db.getDb()
  const chunks = [{ en: 'check in', cn: '办理入住' }, { en: 'it turns out that...', cn: '结果……' }]
  cm.upsertIntroduced({ userId: 7, videoId: 'v1', chunks })
  cm.upsertIntroduced({ userId: 7, videoId: 'v1', chunks })
  const rows = cm.listForVideo(7, 'v1')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.status === 'introduced'))
})

test('applyUsage 更新状态、uses_count 与 used_steps（重复提交同一步不重复计数）', async () => {
  await db.getDb()
  cm.upsertIntroduced({ userId: 8, videoId: 'v2', chunks: [{ en: 'check in', cn: '办理入住' }] })
  const chunks = [{ id: 0, en: 'check in' }]
  const usage = [{ chunkId: 0, used: true, quality: 'good' }]
  cm.applyUsage({ userId: 8, videoId: 'v2', chunks, chunkUsage: usage, step: 2, score: 80 })
  cm.applyUsage({ userId: 8, videoId: 'v2', chunks, chunkUsage: usage, step: 2, score: 90 })
  let row = cm.listForVideo(8, 'v2')[0]
  assert.equal(row.status, 'activated')
  assert.equal(row.uses_count, 1)
  assert.equal(row.last_score, 90)
  assert.deepEqual(JSON.parse(row.used_steps), [2])

  cm.applyUsage({ userId: 8, videoId: 'v2', chunks, chunkUsage: usage, step: 4 })
  row = cm.listForVideo(8, 'v2')[0]
  assert.equal(row.status, 'mastered')
  assert.equal(row.uses_count, 2)

  cm.applyUsage({ userId: 8, videoId: 'v2', chunks: [{ id: 0, en: 'check in' }],
    chunkUsage: [{ chunkId: 99, used: true, quality: 'good' }], step: 2 })
  assert.equal(cm.listForVideo(8, 'v2')[0].uses_count, 2, '越界 chunkId 不记账')
})

test('bucketsOf 按状态分四堆', () => {
  const rows = [
    { chunk_key: 'a', status: 'mastered' }, { chunk_key: 'b', status: 'activated' },
    { chunk_key: 'c', status: 'review' }, { chunk_key: 'd', status: 'introduced' },
  ]
  const b = cm.bucketsOf(rows)
  assert.deepEqual(b.mastered.map(r => r.chunk_key), ['a'])
  assert.deepEqual(b.selfUsed.map(r => r.chunk_key), ['b'])
  assert.deepEqual(b.review.map(r => r.chunk_key), ['c'])
  assert.deepEqual(b.introduced.map(r => r.chunk_key), ['d'])
})

test('applyUsage 只让 step 2–5 记入 used_steps（第 1 步不计账）', async () => {
  await db.getDb()
  cm.upsertIntroduced({ userId: 9, videoId: 'v3', chunks: [{ en: 'same chunk', cn: '同一个语块' }] })
  const chunks = [{ id: 0, en: 'same chunk' }]
  cm.applyUsage({ userId: 9, videoId: 'v3', chunks, chunkUsage: [{ chunkId: 0, used: true, quality: 'good' }], step: 1 })
  const row = cm.listForVideo(9, 'v3')[0]
  assert.equal(row.uses_count, 0)
  assert.equal(row.status, 'introduced')
})
