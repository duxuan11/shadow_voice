import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASKS, LEARNED_THRESHOLD, computeVideoProgress, hasAnyPractice, getLearningStatus,
} from './learningStatus.js'

describe('computeVideoProgress', () => {
  it('无记录为 0', () => {
    assert.equal(computeVideoProgress({}, 100), 0)
    assert.equal(computeVideoProgress(null, 100), 0)
  })

  it('三项完成率取算术平均', () => {
    const p = computeVideoProgress({ shadow: 100, cloze: 80, translate: 50 }, 100)
    assert.ok(Math.abs(p - (1 + 0.8 + 0.5) / 3) < 1e-9)
  })

  it('单项完成率夹到 1（防超 100%）', () => {
    const p = computeVideoProgress({ shadow: 150, cloze: 0, translate: 0 }, 100)
    assert.ok(Math.abs(p - 1 / 3) < 1e-9)
  })

  it('subtitleCount 非法或为 0 时返回 0', () => {
    assert.equal(computeVideoProgress({ shadow: 5 }, 0), 0)
    assert.equal(computeVideoProgress({ shadow: 5 }, undefined), 0)
    assert.equal(computeVideoProgress({ shadow: 5 }, NaN), 0)
  })

  it('缺少任务字段按 0 处理', () => {
    assert.ok(Math.abs(computeVideoProgress({ shadow: 30 }, 100) - 0.1) < 1e-9)
  })
})

describe('hasAnyPractice', () => {
  it('全 0 / 空 → false', () => {
    assert.equal(hasAnyPractice({}), false)
    assert.equal(hasAnyPractice({ shadow: 0, cloze: 0, translate: 0 }), false)
    assert.equal(hasAnyPractice(null), false)
  })
  it('有任一非 0 → true', () => {
    assert.equal(hasAnyPractice({ translate: 1 }), true)
  })
})

describe('getLearningStatus', () => {
  it('全 0 → not_learned', () => {
    assert.equal(getLearningStatus({}, 0), 'not_learned')
  })
  it('有记录但 <75% → learning', () => {
    assert.equal(getLearningStatus({ shadow: 10 }, 0.5), 'learning')
    assert.equal(getLearningStatus({ shadow: 10 }, 0.749), 'learning')
  })
  it('>=75% → learned', () => {
    assert.equal(getLearningStatus({ shadow: 10 }, 0.75), 'learned')
    assert.equal(getLearningStatus({ shadow: 10 }, 1), 'learned')
  })
  it('有记录但 progress 为 0（分母异常）→ learning', () => {
    assert.equal(getLearningStatus({ shadow: 5 }, 0), 'learning')
  })
})

describe('常量', () => {
  it('任务与阈值固定', () => {
    assert.deepEqual(TASKS, ['shadow', 'cloze', 'translate'])
    assert.equal(LEARNED_THRESHOLD, 0.75)
  })
})
