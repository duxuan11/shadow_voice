import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cnReady, missingCnCount, shadowDoneCount, translateDoneCount, percent,
  resumeIndex, findShadow, reviewFromSavedAnswer, avgScore, statusLabel, formatDate,
  buildUpdatePayload, initialTab,
} from './textPractice.js'

const S = [{ i: 0, en: 'a', cn: '甲', section: '' }, { i: 1, en: 'b', cn: '', section: '' }]

test('cnReady / missingCnCount', () => {
  assert.equal(cnReady([{ cn: '甲' }]), true)
  assert.equal(cnReady(S), false)
  assert.equal(cnReady([]), false)
  assert.equal(missingCnCount(S), 1)
  assert.equal(missingCnCount(undefined), 0)
})

test('已完成计数与百分比', () => {
  assert.equal(shadowDoneCount({ shadow: [{ index: 0 }, { index: 1 }] }), 2)
  assert.equal(shadowDoneCount(null), 0)
  assert.equal(translateDoneCount({ answers: [{ index: 0 }] }), 1)
  assert.equal(translateDoneCount({}), 0)
  assert.equal(percent(3, 12), 25)
  assert.equal(percent(0, 0), 0)
  assert.equal(percent(5, 3), 100)
})

test('resumeIndex：从游标起找第一条没练过的，末尾回退', () => {
  const answers = [{ index: 0 }, { index: 1 }]
  assert.equal(resumeIndex(answers, 0, 4), 2)
  assert.equal(resumeIndex(answers, 2, 4), 2)
  assert.equal(resumeIndex(answers, 4, 4), 3)
  assert.equal(resumeIndex([], 9, 4), 3)
  assert.equal(resumeIndex([], 0, 0), 0)
  assert.equal(resumeIndex([{ index: 0 }, { index: 1 }, { index: 2 }], 0, 3), 0)
})

test('findShadow / reviewFromSavedAnswer / avgScore / statusLabel', () => {
  assert.deepEqual(findShadow([{ index: 1, best: 77 }], 1), { index: 1, best: 77 })
  assert.equal(findShadow([], 3), null)
  assert.equal(findShadow(null, 0), null)
  assert.equal(reviewFromSavedAnswer(null), null)
  assert.deepEqual(
    reviewFromSavedAnswer({ index: 0, score: 80, verdict: 'minor', issues: [], better: 'B', praise: 'P' }),
    { verdict: 'minor', score: 80, issues: [], better: 'B', praise: 'P', hint: '', parseError: false },
  )
  assert.equal(avgScore([{ score: 80 }, { score: null }, { score: 90 }]), 85)
  assert.equal(avgScore([{ score: null }]), null)
  assert.equal(statusLabel('completed'), '已完成')
  assert.equal(statusLabel('active'), '进行中')
})

test('formatDate：SQLite datetime 当 UTC 解析，非法值原样回退', () => {
  assert.match(formatDate('2026-10-26 09:00:00'), /^\d{1,2}月\d{1,2}日$/)
  assert.match(formatDate('2026-10-26T09:00:00Z'), /^\d{1,2}月\d{1,2}日$/)
  assert.equal(formatDate(''), '')
  assert.equal(formatDate(null), '')
  assert.equal(formatDate('bogus'), 'bogus')
})

test('buildUpdatePayload：正文没变就只发标题', () => {
  assert.deepEqual(buildUpdatePayload({ title: 'T', text: 'a', originalText: 'a' }), { title: 'T' })
  assert.deepEqual(buildUpdatePayload({ title: 'T', text: 'b', originalText: 'a' }), { title: 'T', text: 'b' })
})

test('initialTab：已完成默认看向完成面板', () => {
  assert.equal(initialTab({ status: 'completed' }), 'translate')
  assert.equal(initialTab({ status: 'active' }), 'shadow')
  assert.equal(initialTab(null), 'shadow')
})
