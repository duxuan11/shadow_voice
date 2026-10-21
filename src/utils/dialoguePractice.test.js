import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIFFICULTY_LABELS, difficultyFromVideoLevel, progressLabel, contextOf,
  primaryAction, summarizeAnswers, prevIndex, nextIndex, reviewFromSavedAnswer,
} from './dialoguePractice.js'

const lines = [
  { index: 0, speakerCn: '前台', cn: '您好，请问有预订吗？', en: 'Do you have a reservation?' },
  { index: 1, speakerCn: '你', cn: '我刚办好入住。', en: "I've just checked in." },
  { index: 2, speakerCn: '前台', cn: '祝您入住愉快。', en: 'Enjoy your stay.' },
]

test('难度文案与视频等级映射', () => {
  assert.deepEqual(DIFFICULTY_LABELS, { easy: '简单', daily: '日常', advanced: '进阶' })
  assert.equal(difficultyFromVideoLevel('初级'), 'easy')
  assert.equal(difficultyFromVideoLevel('高级'), 'advanced')
  assert.equal(difficultyFromVideoLevel('中级'), 'daily')
  assert.equal(difficultyFromVideoLevel(null), 'daily')
})

test('progressLabel 显示当前句 / 总数并钳制越界', () => {
  assert.equal(progressLabel(2, 12), '3/12')
  assert.equal(progressLabel(0, 0), '0/0')
  assert.equal(progressLabel(99, 12), '12/12')
  assert.equal(progressLabel(-3, 12), '1/12')
})

test('contextOf 取前一句，第一句无上下文', () => {
  assert.equal(contextOf(lines, 0), null)
  assert.deepEqual(contextOf(lines, 1), { speakerCn: '前台', cn: '您好，请问有预订吗？' })
  assert.equal(contextOf(lines, 99), null)
  assert.equal(contextOf(null, 1), null)
})

test('primaryAction：wrong 且第一次 → retry；其余 → next', () => {
  assert.equal(primaryAction({ verdict: 'wrong', answerHidden: true }, 1), 'retry')
  assert.equal(primaryAction({ verdict: 'wrong', answerHidden: false }, 2), 'next')
  assert.equal(primaryAction({ verdict: 'minor', score: 72 }, 1), 'next')
  assert.equal(primaryAction({ verdict: 'correct', score: 95 }, 1), 'next')
  assert.equal(primaryAction(null, 0), 'next')
})

test('summarizeAnswers 聚合均分 / 一次通过率 / 高频错误 / 需复习', () => {
  const answers = [
    { index: 0, attempts: 1, score: 90, verdict: 'correct', issues: [] },
    { index: 1, attempts: 2, score: 60, verdict: 'wrong', issues: [{ type: 'grammar' }, { type: 'grammar' }] },
    { index: 2, attempts: 1, score: 78, verdict: 'minor', issues: [{ type: 'naturalness' }] },
  ]
  const s = summarizeAnswers(answers, lines)
  assert.equal(s.total, 3)
  assert.equal(s.answered, 3)
  assert.equal(s.averageScore, 76)
  assert.equal(s.firstTryRate, 33) // 只有 index 0 是一次通过（>=80）
  assert.deepEqual(s.topIssues, [{ type: 'grammar', count: 2 }, { type: 'naturalness', count: 1 }])
  assert.deepEqual(s.reviewLines.map(r => r.index), [1, 2])
  assert.equal(s.reviewLines[0].en, "I've just checked in.")
})

test('summarizeAnswers 容忍空/畸形输入', () => {
  assert.deepEqual(summarizeAnswers(null, null),
    { total: 0, answered: 0, averageScore: null, firstTryRate: null, topIssues: [], reviewLines: [] })
  const s = summarizeAnswers([{ index: 0, attempts: 1, score: null }], lines)
  assert.equal(s.averageScore, null)
  assert.equal(s.answered, 1)
})

test('prevIndex：第一句返回 null，其余上移一句并钳制', () => {
  assert.equal(prevIndex(0, 12), null)
  assert.equal(prevIndex(1, 12), 0)
  assert.equal(prevIndex(5, 12), 4)
  assert.equal(prevIndex(99, 12), 10)
  assert.equal(prevIndex(0, 0), null)
  assert.equal(prevIndex(-3, 12), null)
})

test('nextIndex：最后一句返回 null（该结束练习），其余下移一句', () => {
  assert.equal(nextIndex(0, 12), 1)
  assert.equal(nextIndex(10, 12), 11)
  assert.equal(nextIndex(11, 12), null)
  assert.equal(nextIndex(5, 0), null)
  assert.equal(nextIndex(99, 12), null)
})

test('reviewFromSavedAnswer：回看已答句时还原可见的反馈', () => {
  const restored = reviewFromSavedAnswer({
    index: 2, attempts: 2, userText: 'I check in just now', score: 45, verdict: 'wrong',
    issues: [{ type: 'grammar', better: 'checked in' }], better: 'I have just checked in.', praise: '还行',
  })
  assert.equal(restored.verdict, 'wrong')
  assert.equal(restored.score, 45)
  assert.equal(restored.better, 'I have just checked in.')
  assert.equal(restored.issues[0].better, 'checked in')
  assert.equal(restored.answerHidden, false) // 已经答过，答案不再藏
  assert.equal(restored.parseError, undefined)
})

test('reviewFromSavedAnswer：没有作答记录返回 null', () => {
  assert.equal(reviewFromSavedAnswer(null), null)
  assert.equal(reviewFromSavedAnswer(undefined), null)
  assert.equal(reviewFromSavedAnswer({ index: 0 }), null)
  assert.equal(reviewFromSavedAnswer({ index: 0, verdict: 'correct' }), null) // 没有分数/判定结果不算已评
})
