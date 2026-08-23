const test = require('node:test')
const assert = require('node:assert/strict')

const {
  PROMPT_VERSION,
  buildTopicsPrompt,
  buildOpeningPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  localExtractTopics,
  buildHistory,
} = require('./conversation.cjs')

const segments = [
  { segmentIndex: 0, textEn: "we've just checked in and now we need to go to our room", textCn: '我们刚办好入住' },
  { segmentIndex: 1, textEn: 'so let\'s take the lift', textCn: '我们去坐电梯' },
  { segmentIndex: 2, textEn: 'normally the concierge takes your bags', textCn: '礼宾员拿行李' },
  { segmentIndex: 3, textEn: 'this is a railing', textCn: '这是栏杆' },
  { segmentIndex: 4, textEn: 'it is a very beautiful beach', textCn: '很美的海滩' },
  { segmentIndex: 5, textEn: 'hi', textCn: '嗨' },
]

test('PROMPT_VERSION 稳定用于缓存键', () => {
  assert.equal(PROMPT_VERSION, 'topics-v1')
})

test('buildTopicsPrompt 包含标题与字幕段', () => {
  const p = buildTopicsPrompt({ videoTitle: '酒店日常', segments })
  assert.ok(p.system.length > 0)
  assert.ok(p.user.includes('酒店日常'))
  assert.ok(p.user.includes('checked in'))
  assert.ok(p.user.includes('concierge'))
})

test('buildOpeningPrompt 包含主题素材', () => {
  const topics = { words: [{ word: 'concierge' }], phrases: [{ phrase: 'check in' }], collocations: [{ collocation: 'take care of' }], source: 'ai' }
  const p = buildOpeningPrompt({ videoTitle: '酒店日常', topics, level: '中级' })
  assert.ok(p.user.includes('concierge'))
  assert.ok(p.user.includes('check in'))
})

test('buildReplyPrompt 包含历史', () => {
  const history = [
    { role: 'ai', text: 'So you just checked in?' },
    { role: 'user', text: 'Yes, it was quick.' },
  ]
  const p = buildReplyPrompt({ topics: { words: [] }, history })
  assert.ok(p.user.includes('So you just checked in?'))
  assert.ok(p.user.includes('Yes, it was quick.'))
})

test('buildReviewPrompt 包含历史与要求', () => {
  const history = [
    { role: 'ai', text: 'So you just checked in?' },
    { role: 'user', text: 'Yes, it was quick.' },
  ]
  const p = buildReviewPrompt({ topics: { words: [{ word: 'concierge' }] }, history })
  assert.ok(p.user.includes('Yes, it was quick.'))
  assert.ok(p.system.toLowerCase().includes('json'))
})

test('localExtractTopics 从字幕提取单词/短语(本地降级)', () => {
  const t = localExtractTopics(segments)
  assert.ok(t.words.length >= 3, '应提取到多个高频词')
  assert.ok(t.phrases.length >= 2, '应提取到短语')
  assert.equal(t.source, 'local')
  // 词卡：concierge / lift 等实词应出现
  const words = t.words.map(w => w.word.toLowerCase())
  assert.ok(words.some(w => w.includes('concierge') || w.includes('bag') || w.includes('lift') || w.includes('check')), `高频实词缺失: ${words.join(',')}`)
  // 短句 'hi' 不产生候选
  assert.ok(!words.includes('hi'))
})

test('localExtractTopics 结果结构完整', () => {
  const t = localExtractTopics(segments)
  assert.ok(Array.isArray(t.words) && Array.isArray(t.phrases) && Array.isArray(t.collocations))
  for (const w of t.words) {
    assert.ok(w.word && w.count >= 1)
  }
  for (const p of t.phrases) {
    assert.ok(p.phrase && p.meaning && p.example)
  }
})

test('buildHistory 组装消息数组', () => {
  const msgs = [
    { role: 'user', text: 'a' },
    { role: 'ai', text: 'b' },
    { role: 'user', text: 'c' },
  ]
  const h = buildHistory(msgs)
  assert.equal(h.length, 3)
  assert.equal(h[0].role, 'user')
  assert.equal(h[0].content, 'a')
  assert.equal(h[2].role, 'user')
})

test('buildHistory forReview 模式按 id 排序并包含用户轮次', () => {
  const msgs = [
    { id: 1, role: 'ai', text: 'q1' },
    { id: 2, role: 'user', text: 'a1' },
    { id: 3, role: 'ai', text: 'q2' },
    { id: 4, role: 'user', text: 'a2' },
    { id: 5, role: 'ai', text: 'q3' },
  ]
  const h = buildHistory(msgs, { forReview: true })
  assert.equal(h.length, 4) // 最近 2 条 AI + 2 条 user
  assert.equal(h[0].content, '[2] a1') // id 2（带 [id] 前缀供 AI 消歧）
  assert.equal(h[1].content, '[3] q2') // id 3
  assert.equal(h[2].content, '[4] a2') // id 4
  assert.equal(h[3].content, '[5] q3') // id 5
  assert.equal(h[0].role, 'user')
  assert.equal(h[1].role, 'assistant')
})

test('回归: buildReplyPrompt 消费 buildHistory 输出(历史真实可见,非 undefined)', () => {
  const msgs = [
    { id: 1, role: 'ai', text: 'So you just checked in?' },
    { id: 2, role: 'user', text: 'Yes, it was quick.' },
  ]
  const history = buildHistory(msgs)
  const p = buildReplyPrompt({ topics: { words: [] }, history })
  assert.ok(p.user.includes('So you just checked in?'), 'AI 历史应在 prompt 中')
  assert.ok(p.user.includes('Yes, it was quick.'), '用户历史应在 prompt 中')
  assert.ok(!p.user.includes('undefined'), '历史不能是 undefined')
})

test('回归: buildReviewPrompt 消费 buildHistory(forReview) 输出(用户轮次可见)', () => {
  const msgs = [
    { id: 1, role: 'ai', text: 'q1' },
    { id: 2, role: 'user', text: 'I stayed here before' },
    { id: 3, role: 'ai', text: 'q2' },
    { id: 4, role: 'user', text: 'the room is very nice' },
  ]
  const history = buildHistory(msgs, { forReview: true })
  const p = buildReviewPrompt({ topics: { words: [] }, history })
  assert.ok(p.user.includes('I stayed here before'), '用户轮次应在 review prompt 中')
  assert.ok(p.user.includes('the room is very nice'))
  assert.ok(!p.user.includes('undefined'), '历史不能是 undefined')
})
