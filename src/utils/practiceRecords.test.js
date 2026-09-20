import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRACTICE_TASKS, emptyPracticeData, addIndex,
  markLocal, loadLocalOne, loadLocalSummary, resetLocalPractice,
} from './practiceRecords.js'

// 最小 localStorage 替身，供 node:test 环境使用
beforeEach(() => {
  const store = {}
  globalThis.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: k => { delete store[k] },
  }
})

describe('addIndex', () => {
  it('加入新索引并返回新对象', () => {
    const before = emptyPracticeData()
    const after = addIndex(before, 'shadow', 3)
    assert.deepEqual(after.shadow, [3])
    assert.deepEqual(before.shadow, []) // 不可变
  })
  it('重复索引不变', () => {
    const data = addIndex({ shadow: [1] }, 'shadow', 1)
    assert.deepEqual(data.shadow, [1])
  })
  it('非法 task / index 原样返回', () => {
    const data = { shadow: [1] }
    assert.equal(addIndex(data, 'hack', 0), data)
    assert.equal(addIndex(data, 'shadow', -1), data)
    assert.equal(addIndex(data, 'shadow', 1.5), data)
    assert.equal(addIndex(data, 'shadow', '2'), data)
  })
  it('任务与常量一致', () => {
    assert.deepEqual(PRACTICE_TASKS, ['shadow', 'cloze', 'translate'])
  })
})

describe('游客本地存储', () => {
  it('markLocal 去重，loadLocalOne / loadLocalSummary 可读', () => {
    resetLocalPractice()
    markLocal('v1', 'cloze', 2)
    markLocal('v1', 'cloze', 2)
    markLocal('v1', 'translate', 5)
    assert.deepEqual(loadLocalOne('v1').cloze, [2])
    assert.deepEqual(loadLocalSummary().v1, { shadow: 0, cloze: 1, translate: 1 })
  })
  it('无记录返回空结构', () => {
    resetLocalPractice()
    assert.deepEqual(loadLocalOne('nope'), { shadow: [], cloze: [], translate: [] })
    assert.deepEqual(loadLocalSummary(), {})
  })
})
