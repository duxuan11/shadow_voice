const test = require('node:test')
const assert = require('node:assert/strict')
const { buildReviewPrompt, parseReview, reviewFromContent } = require('./speak.cjs')

test('buildReviewPrompt 包含 cn/en/userText 与关键规则', () => {
  const p = buildReviewPrompt({ cn: '我们办理了入住。', en: 'We checked in.', userText: 'We check in.' })
  assert.ok(p.system.includes('不是唯一答案'))
  assert.ok(p.system.includes('搭配'))
  assert.ok(p.user.includes('我们办理了入住。'))
  assert.ok(p.user.includes('We checked in.'))
  assert.ok(p.user.includes('We check in.'))
})

test('parseReview 正常对象逐字段保留', () => {
  const r = parseReview({ score: 85, issues: [{ type: 'collocation', location: 'x', problem: 'p', suggestion: 's', better: 'b' }], better: 'B', praise: '不错', lowScoreHint: '提示' })
  assert.equal(r.score, 85)
  assert.equal(r.issues[0].type, 'collocation')
  assert.equal(r.better, 'B')
  assert.equal(r.praise, '不错')
  assert.equal(r.lowScoreHint, '') // score>=70 强制清空
})

test('parseReview 钳制越界分数', () => {
  assert.equal(parseReview({ score: 150 }).score, 100)
  assert.equal(parseReview({ score: -5 }).score, 0)
  assert.equal(parseReview({ score: 'abc' }).score, null)
  assert.equal(parseReview({}).score, null)
})

test('parseReview 低分才给提示', () => {
  assert.equal(parseReview({ score: 60, lowScoreHint: '注意时态' }).lowScoreHint, '注意时态')
  assert.equal(parseReview({ score: 70, lowScoreHint: 'x' }).lowScoreHint, '')
  assert.equal(parseReview({ score: null, lowScoreHint: 'x' }).lowScoreHint, '')
})

test('parseReview 容忍缺失字段', () => {
  assert.deepEqual(parseReview(null), { score: null, issues: [], better: '', praise: '', lowScoreHint: '' })
  assert.deepEqual(parseReview({ score: 80, issues: 'not-array' }).issues, [])
})

test('reviewFromContent 解析畸形 → parseError', () => {
  assert.equal(reviewFromContent('not json at all').review.parseError, true)
  assert.equal(reviewFromContent('not json at all').review.score, null)
  const ok = reviewFromContent('{"score":90,"issues":[],"better":"B","praise":"好","lowScoreHint":""}')
  assert.equal(ok.review.score, 90)
  assert.equal(ok.review.parseError, undefined)
})
