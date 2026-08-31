// 观看历史 util 回归测试：去重、最近在前、上限 50、损坏 JSON 容错、清空。
// 背景：LearningRecords/Profile 一直读取 shadow_voice_watched，但没有任何代码写入，
// 导致「观看历史/最近观看」永远为空 —— recordWatch 就是缺失的写入侧。
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readWatchHistory, recordWatch, clearWatchHistory } from './watchedHistory.js'

// node 环境无 localStorage —— 用最小内存 mock
const store = new Map()
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
}

beforeEach(() => store.clear())

describe('recordWatch / readWatchHistory', () => {
  it('空历史时写入单个 id', () => {
    const next = recordWatch('v1')
    assert.deepEqual(next, ['v1'])
    assert.deepEqual(readWatchHistory(), ['v1'])
  })

  it('新观看排在最前', () => {
    recordWatch('v1')
    const next = recordWatch('v2')
    assert.deepEqual(next, ['v2', 'v1'])
  })

  it('重复观看去重并置顶', () => {
    recordWatch('v1')
    recordWatch('v2')
    const next = recordWatch('v1')
    assert.deepEqual(next, ['v1', 'v2'])
  })

  it('超过 50 条时截断最旧记录', () => {
    for (let i = 1; i <= 55; i++) recordWatch(`v${i}`)
    const list = readWatchHistory()
    assert.equal(list.length, 50)
    assert.equal(list[0], 'v55') // 最近的在最前
    assert.equal(list[49], 'v6') // v1..v5 被淘汰
  })

  it('损坏的 JSON 容错为空数组', () => {
    store.set('shadow_voice_watched', '{oops')
    assert.deepEqual(readWatchHistory(), [])
  })

  it('recordWatch 传入空 id 不写入', () => {
    recordWatch('')
    assert.deepEqual(readWatchHistory(), [])
  })

  it('clearWatchHistory 清空', () => {
    recordWatch('v1')
    clearWatchHistory()
    assert.deepEqual(readWatchHistory(), [])
  })
})
