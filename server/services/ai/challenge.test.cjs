const test = require('node:test')
const assert = require('node:assert/strict')
const {
  RECALL_COUNT, CHUNK_COUNT, TRANSFORMATION_COUNT,
  normalizeChunkKey, isEvidenceInTranscript, buildFallbackChunks,
  buildChallengePrompt, normalizeChallenge, buildTranscriptDigest,
} = require('./challenge.cjs')

const SEGMENTS = [
  { textEn: "We'd like to check in, please.", textCn: '我们想办理入住。' },
  { textEn: 'It turns out that the room is not ready.', textCn: '结果房间还没准备好。' },
  { textEn: "Let's take the lift to the 21st floor.", textCn: '我们坐电梯到21楼吧。' },
  { textEn: 'Could you hold my bags for now?', textCn: '你能先帮我存包吗？' },
  { textEn: 'In the end we got a bigger room.', textCn: '最后我们换到了更大的房间。' },
]
const TRANSCRIPT = SEGMENTS.map(s => s.textEn).join(' ')

function goodRaw() {
  return {
    title: '酒店入住 · 主动输出挑战', topicEn: 'staying in a hotel', topicCn: '酒店入住',
    recall: [
      { qEn: 'What do they want at the front desk?', qCn: '他们在前台想做什么？', focusCn: '办理入住' },
      { qEn: 'Why is the room not ready?', qCn: '房间为什么没准备好？', focusCn: '房间未就绪' },
      { qEn: 'What do they do in the end?', qCn: '他们最后做了什么？', focusCn: '换到更大房间' },
    ],
    chunks: [
      { en: "We'd like to check in", cn: '我们想办理入住', evidence: "We'd like to check in, please.", usageCn: '说说你最近一次办入住' },
      { en: 'it turns out that', cn: '结果（发现）……', evidence: 'It turns out that the room is not ready.', usageCn: '说一件出乎意料的事' },
      { en: 'hold my bags', cn: '帮我存包', evidence: 'Could you hold my bags for now?', usageCn: '请人帮你保管东西' },
      { en: 'in the end', cn: '最终', evidence: 'In the end we got a bigger room.', usageCn: '讲一件事情的结局' },
      { en: 'take the lift', cn: '坐电梯', evidence: "Let's take the lift to the 21st floor.", usageCn: '说说你怎么上楼' },
    ],
    transformations: Array.from({ length: 5 }, (_, i) => ({
      situationCn: `情境${i + 1}：你在酒店前台需要提出一个请求。`, targetChunkId: i, hintCn: '先说明来意',
    })),
    topicSpeaking: {
      promptEn: 'Describe a travel problem that turned out fine.',
      promptCn: '讲一次旅行中的小麻烦最后顺利解决的经历。',
      pointsCn: ['发生了什么', '你怎么处理', '结果和感受'], targetSeconds: 200,
    },
  }
}

test('normalizeChunkKey 与证据匹配容忍大小写/标点', () => {
  assert.equal(normalizeChunkKey('It Turns Out THAT...'), 'it turns out that')
  assert.equal(isEvidenceInTranscript('turns out that the room', TRANSCRIPT), true)
  assert.equal(isEvidenceInTranscript('turns that out', TRANSCRIPT), false)
  assert.equal(isEvidenceInTranscript('completely invented line', TRANSCRIPT), false)
})

test('buildChallengePrompt 带字幕、难度、套数与避免重复清单', () => {
  const { system, user } = buildChallengePrompt({
    videoTitle: '出国旅行的日常', description: '酒店入住', topic: '旅游出行',
    videoLevel: '中级', segments: SEGMENTS, variant: 2, avoid: { chunks: ['check in'] },
  })
  assert.ok(system.includes('五步口语挑战'))
  assert.ok(user.includes('出国旅行的日常'))
  assert.ok(user.includes("We'd like to check in, please."))
  assert.ok(user.includes('第 2 套'))
  assert.ok(user.includes('check in'), 'avoid 清单要进 prompt')
  assert.ok(user.includes('"recall"') && user.includes('"chunks"') && user.includes('"topicSpeaking"'))
})

test('normalizeChallenge 正常输入产出 3/5/5 并夹紧话题时长', () => {
  const r = normalizeChallenge(goodRaw(), { segmentsText: TRANSCRIPT })
  assert.equal(r.ok, true)
  assert.equal(r.challenge.recall.length, RECALL_COUNT)
  assert.equal(r.challenge.chunks.length, CHUNK_COUNT)
  assert.equal(r.challenge.transformations.length, TRANSFORMATION_COUNT)
  assert.equal(r.challenge.topicSpeaking.targetSeconds, 120, '200 秒夹到 120')
  assert.equal(r.challenge.source, 'subtitle')
  assert.deepEqual(r.challenge.chunks.map(c => c.id), [0, 1, 2, 3, 4])
})

test('normalizeChallenge 缺题/缺情境直接失败', () => {
  const raw = goodRaw()
  raw.recall = raw.recall.slice(0, 2)
  const r = normalizeChallenge(raw, { segmentsText: TRANSCRIPT })
  assert.equal(r.ok, false)
  assert.match(r.reason, /复述题/)

  const raw2 = goodRaw()
  raw2.transformations = raw2.transformations.slice(0, 4)
  const r2 = normalizeChallenge(raw2, { segmentsText: TRANSCRIPT })
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /情境/)
})

test('normalizeChallenge 证据全部造假时用兜底池补满', () => {
  const raw = goodRaw()
  raw.chunks = raw.chunks.map(c => ({ ...c, evidence: 'invented sentence not in video' }))
  // 兜底池由路由从「字幕衍生」构造：这里用真实字幕行当证据
  const fallbackChunks = SEGMENTS.map((s, i) => ({
    en: `fallback ${i}`, cn: `兜底语块${i}`, evidence: s.textEn, source: i === 0 ? 'cache' : 'local',
  }))
  const r = normalizeChallenge(raw, { segmentsText: TRANSCRIPT, fallbackChunks })
  assert.equal(r.ok, true)
  assert.ok(['cache', 'local'].includes(r.challenge.source))
  assert.equal(r.challenge.chunks.length, CHUNK_COUNT)
  for (const c of r.challenge.chunks) {
    assert.ok(isEvidenceInTranscript(c.evidence, TRANSCRIPT))
  }
})

test('normalizeChallenge 兜底也不够时失败（不编造）', () => {
  const raw = goodRaw()
  raw.chunks = raw.chunks.map(c => ({ ...c, evidence: 'invented' }))
  const r = normalizeChallenge(raw, { segmentsText: TRANSCRIPT, fallbackChunks: [] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /语块/)
})

test('buildFallbackChunks 只用字幕里真实存在的表达', () => {
  const chunks = buildFallbackChunks({ segments: SEGMENTS })
  assert.ok(chunks.length > 0 && chunks.length <= 5)
  for (const c of chunks) {
    assert.ok(isEvidenceInTranscript(c.evidence, TRANSCRIPT), `证据不在字幕里: ${c.evidence}`)
    assert.ok(c.en && c.cn, '兜底也要有英文与中文')
  }
})

test('buildTranscriptDigest 截断行数与字符', () => {
  const digest = buildTranscriptDigest(SEGMENTS, 2, 50)
  assert.ok(digest.length <= 50)
  assert.ok(!digest.includes('In the end'), '第 3 行起被截掉')
})

// ─── Task 4：分步反馈 / 对话 / 收尾报告 ───────────────────────────
const {
  buildStepFeedbackPrompt, normalizeStepFeedback, buildChatTurnPrompt,
  normalizeChatReply, buildFinishPrompt, normalizeFinish,
} = require('./challenge.cjs')

const CHALLENGE = normalizeChallenge(goodRaw(), { segmentsText: TRANSCRIPT }).challenge
const DIGEST = buildTranscriptDigest(SEGMENTS)

test('buildStepFeedbackPrompt 带任务原文与本地统计', () => {
  const { system, user } = buildStepFeedbackPrompt({
    step: 2, challenge: CHALLENGE, videoTitle: '出国旅行的日常', transcriptDigest: DIGEST,
    answers: [{ index: 0, chunkText: 'check in', sentence: 'I checked in at noon.' }],
    metrics: { longestSeconds: 12, totalSeconds: 30, segments: 1 },
  })
  assert.ok(system.includes('逐题反馈'))
  assert.ok(user.includes(CHALLENGE.chunks[0].cn))
  assert.ok(user.includes('I checked in at noon.'))
  assert.ok(user.includes('12'))
})

test('normalizeStepFeedback 丢弃越界 chunkId 并补齐 items', () => {
  const fb = normalizeStepFeedback({
    score: 130,
    items: [{ index: 0, comment: '不错', grammar: [{ original: 'a', better: 'b', reason: 'c' }] }],
    chunkUsage: [{ chunkId: 0, used: true, quality: 'good' }, { chunkId: 42, used: true, quality: 'good' }],
    vocabulary: { level: '偏基础', suggestions: ['deposit', 'lobby'] },
    coherence: { summary: '连贯', fillers: ['um'] },
    praise: '敢于开口',
  }, { step: 2, itemCount: 5, chunks: CHALLENGE.chunks })
  assert.equal(fb.score, 100)
  assert.equal(fb.items.length, 5)
  assert.equal(fb.items[1].comment, '')
  assert.equal(fb.items[0].grammar[0].better, 'b')
  assert.deepEqual(fb.chunkUsage.map(u => u.chunkId), [0])
  assert.equal(fb.vocabulary.suggestions.length, 2)
})

test('normalizeStepFeedback 对垃圾输入不抛错', () => {
  for (const raw of [null, 'x', 42, [], { items: 'nope', chunkUsage: [{}] }]) {
    const fb = normalizeStepFeedback(raw, { step: 3, itemCount: 5, chunks: CHALLENGE.chunks })
    assert.equal(fb.items.length, 5)
    assert.equal(fb.score, null)
    assert.deepEqual(fb.chunkUsage, [])
  }
})

test('normalizeChatReply 兼容对象与纯文本', () => {
  assert.deepEqual(normalizeChatReply({ reply: 'Nice! What happened next?' }),
    { ok: true, reply: 'Nice! What happened next?' })
  assert.deepEqual(normalizeChatReply('Just text.'), { ok: true, reply: 'Just text.' })
  assert.deepEqual(normalizeChatReply('   '), { ok: false, reply: '' })
})

test('buildChatTurnPrompt 空历史时要求开场', () => {
  const { system, user } = buildChatTurnPrompt({ challenge: CHALLENGE, videoTitle: 't', history: [] })
  assert.ok(system.includes('对话伙伴'))
  assert.ok(user.includes('开场'))
  const second = buildChatTurnPrompt({
    challenge: CHALLENGE, videoTitle: 't',
    history: [{ role: 'ai', text: 'Hi' }, { role: 'user', text: 'Hello' }],
  })
  assert.ok(second.user.includes('Hello'))
})

test('normalizeFinish 带上本地统计并限制建议条数', () => {
  const r = normalizeFinish({
    chatFeedback: { score: 80, praise: '自然' },
    report: { score: 82, summary: '整体不错', nextSuggestions: ['a', 'b', 'c', 'd'], masteredChunkIds: [0] },
  }, { metrics: { longestSeconds: 78, totalSeconds: 200, segments: 4 } })
  assert.equal(r.ok, true)
  assert.equal(r.report.nextSuggestions.length, 3)
  assert.deepEqual(r.report.speaking, { longestSeconds: 78, totalSeconds: 200, segments: 4 })
  assert.equal(r.chatFeedback.score, 80)
})

test('normalizeFinish 缺 summary 时判定失败', () => {
  assert.equal(normalizeFinish({ report: {} }, { metrics: {} }).ok, false)
  assert.equal(normalizeFinish(null, { metrics: {} }).ok, false)
})
