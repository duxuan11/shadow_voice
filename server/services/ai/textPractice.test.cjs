const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildTranslatePrompt, normalizeTranslations, buildSentenceReviewPrompt, normalizeSentenceReview,
} = require('./textPractice.cjs')

test('翻译 prompt 要求保留术语且只输出 JSON', () => {
  const { system, user } = buildTranslatePrompt({ title: 'U-Net 论文摘要', sentences: ['U-Net beats FCN.'] })
  assert.match(system, /原样保留/)
  assert.match(system, /SAM/)
  assert.match(system, /只输出/)
  assert.match(user, /U-Net 论文摘要/)
  assert.match(user, /U-Net beats FCN\./)
})

test('normalizeTranslations：全齐 → ok', () => {
  const r = normalizeTranslations({ items: [{ i: 0, cn: '甲。' }, { i: 1, cn: ' 乙。 ' }] }, { count: 2 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.items, [{ i: 0, cn: '甲。' }, { i: 1, cn: '乙。' }])
  assert.deepEqual(r.missing, [])
})

test('normalizeTranslations：缺项 / 空串 / 越界 i / 脏数据', () => {
  const r = normalizeTranslations({ items: [{ i: 0, cn: '甲。' }, { i: 9, cn: '越界' }, { i: 1, cn: '  ' }, null] }, { count: 2 })
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, [1])
  assert.deepEqual(r.items, [{ i: 0, cn: '甲。' }])
  assert.deepEqual(normalizeTranslations(null, { count: 1 }), { ok: false, items: [], missing: [0] })
})

test('评分 prompt：中文为空时不出现中文行，重试时提示 attempt', () => {
  const a = buildSentenceReviewPrompt({ title: 'T', en: 'It works.', cn: '', userText: 'It works', attempt: 1 })
  assert.doesNotMatch(a.user, /中文/)
  assert.match(a.system, /同义|等价|高分/)
  const b = buildSentenceReviewPrompt({ title: 'T', en: 'It works.', cn: '它能工作。', userText: 'x', attempt: 2 })
  assert.match(b.user, /它能工作。/)
  assert.match(b.user, /2/)
})

test('normalizeSentenceReview：verdict 合法保留，非法按分数派生', () => {
  assert.equal(normalizeSentenceReview({ verdict: 'minor', score: 70 }).verdict, 'minor')
  assert.equal(normalizeSentenceReview({ verdict: 'whatever', score: 92 }).verdict, 'correct')
  assert.equal(normalizeSentenceReview({ verdict: 'whatever', score: 61 }).verdict, 'minor')
  assert.equal(normalizeSentenceReview({ verdict: 'whatever', score: 40 }).verdict, 'wrong')
  const nullScore = normalizeSentenceReview({ score: null })
  assert.equal(nullScore.score, null)
  assert.equal(nullScore.verdict, 'wrong')
  assert.equal(normalizeSentenceReview(null).parseError, true)
  assert.equal(normalizeSentenceReview({ score: 80, praise: 'good' }).praise, 'good')
})
