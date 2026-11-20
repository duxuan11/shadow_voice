import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STEP_META, CHAT_MIN_TURNS, CHAT_MAX_TURNS, stepStatus, resumeStep, countWords,
  wpm, mergeSegmentText, aggregateSpeaking, countFillers, chatUserTurns,
  canFinishChat, reportBuckets, formatDuration, clampServerText, maskEvidence,
} from './speakingChallenge.js'

test('STEP_META 五步顺序固定', () => {
  assert.deepEqual(STEP_META.map(s => s.step), [1, 2, 3, 4, 5])
  assert.equal(STEP_META[0].title, 'Video Recall')
  assert.equal(STEP_META[4].cn, 'AI 对话')
})

test('stepStatus 区分 done/answered/todo', () => {
  const steps = [{ status: 'completed' }, null, { status: 'answered' }, null, null]
  assert.equal(stepStatus(steps, 1), 'done')
  assert.equal(stepStatus(steps, 2), 'todo')
  assert.equal(stepStatus(steps, 3), 'answered')
  assert.equal(stepStatus(null, 1), 'todo')
})

test('resumeStep 优先回到第一个未完成的步，或报告', () => {
  assert.equal(resumeStep({ status: 'completed', steps: [] }), 5)
  assert.equal(resumeStep({ status: 'active', steps: [{ status: 'completed' }, { status: 'answered' }] }), 1)
  assert.equal(resumeStep({ status: 'active', steps: [] }), 0)
  assert.equal(resumeStep(null), 0)
  assert.equal(resumeStep({ status: 'active', steps: [1, 2, 3, 4].map(() => ({ status: 'completed' })) }), 4)
})

test('countWords / wpm / formatDuration', () => {
  assert.equal(countWords('  I   checked in at noon. '), 5)
  assert.equal(countWords(''), 0)
  assert.equal(wpm(90, 60000), 90)
  assert.equal(wpm(10, 3000), null)
  assert.equal(formatDuration(58000), '58s')
  assert.equal(formatDuration(78000), '1:18')
})

test('mergeSegmentText 切段拼接不丢词不重复不多空格', () => {
  assert.equal(mergeSegmentText('', 'hello'), 'hello')
  assert.equal(mergeSegmentText('hello', ' world'), 'hello world')
  assert.equal(mergeSegmentText('hello ', 'world'), 'hello world')
  assert.equal(mergeSegmentText('we checked', 'in at noon'), 'we checked in at noon')
  assert.equal(mergeSegmentText('abc', ''), 'abc')
})

test('aggregateSpeaking 取单次尝试的最大时长，累计总时长与段数', () => {
  const r = aggregateSpeaking([
    { durationMs: 90000, segments: 2 },   // 一次尝试：两段录音累加 90 秒
    { durationMs: 40000, segments: 1 },   // 另一次尝试（重录）
  ])
  assert.equal(r.longestSeconds, 90)
  assert.equal(r.totalSeconds, 130)
  assert.equal(r.segments, 3)
  assert.deepEqual(aggregateSpeaking([]), { longestSeconds: 0, totalSeconds: 0, segments: 0 })
})

test('countFillers 命中去重且忽略大小写', () => {
  assert.deepEqual(countFillers('Um, I think, um, like it works'), ['um', 'like'])
  assert.deepEqual(countFillers('no fillers here'), [])
})

test('chat 轮次与结束条件', () => {
  const msgs = (n) => Array.from({ length: n }, () => [{ role: 'ai' }, { role: 'user' }]).flat()
  assert.equal(chatUserTurns(msgs(3)), 3)
  assert.equal(canFinishChat(msgs(4)).can, false)
  assert.equal(canFinishChat(msgs(CHAT_MIN_TURNS)).can, true)
  assert.equal(canFinishChat(msgs(CHAT_MAX_TURNS)).reason, 'max')
})

test('reportBuckets 从 mastery 取四堆', () => {
  const b = reportBuckets({ mastered: [1], selfUsed: [2], review: [3], introduced: [4] })
  assert.deepEqual([b.mastered.length, b.selfUsed.length, b.review.length, b.introduced.length], [1, 1, 1, 1])
  assert.deepEqual(reportBuckets(null), { mastered: [], selfUsed: [], review: [], introduced: [] })
})

test('clampServerText 截断到上限', () => {
  assert.equal(clampServerText('abcdef', 3), 'abc')
  assert.equal(clampServerText('abc', 10), 'abc')
})

test('maskEvidence 遮住英文原句又不留字母', () => {
  assert.deepEqual(maskEvidence('').length, 0)
  const masked = maskEvidence('Hold my bags')
  assert.ok(masked.length > 0)
  assert.ok(!/[A-Za-z]/.test(masked), `仍含字母: ${masked}`)
})
