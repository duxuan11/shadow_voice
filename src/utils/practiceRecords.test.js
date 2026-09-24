import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRACTICE_TASKS, emptyPracticeData, addIndex, firstUnpracticedIndex,
  markLocal, loadLocalOne, loadLocalSummary, resetLocalPractice,
  loadSummary, loadOne, mark,
} from './practiceRecords.js'

// 记录 authFetch 调用并返回可编排的响应替身
function makeAuthFetch(respond) {
  const calls = []
  const authFetch = (path, options) => {
    calls.push({ path, options })
    return respond(path, options)
  }
  authFetch.calls = calls
  return authFetch
}

const okJson = body => () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })

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

describe('firstUnpracticedIndex', () => {
  it('返回第一个没练过的下标', () => {
    assert.equal(firstUnpracticedIndex(new Set([0, 1, 3]), 5), 2)
    assert.equal(firstUnpracticedIndex(new Set(), 3), 0)
  })
  it('全部练完时回到第 1 句', () => {
    assert.equal(firstUnpracticedIndex(new Set([0, 1, 2]), 3), 0)
  })
  it('忽略越界记录，非法 total 返回 -1', () => {
    assert.equal(firstUnpracticedIndex(new Set([9, 10]), 2), 0)
    assert.equal(firstUnpracticedIndex(new Set([0]), 0), -1)
    assert.equal(firstUnpracticedIndex(new Set([0]), -3), -1)
  })
  it('非 Set 的练习记录按空处理', () => {
    assert.equal(firstUnpracticedIndex(null, 3), 0)
    assert.equal(firstUnpracticedIndex([0, 1], 3), 0)
  })
})

describe('登录用户网络路径', () => {
  it('loadSummary 请求 /practice/summary 并返回 body.summary', async () => {
    const authFetch = makeAuthFetch(okJson({ summary: { v1: { cloze: 2 } } }))
    const summary = await loadSummary(authFetch, false)
    assert.deepEqual(summary, { v1: { cloze: 2 } })
    assert.equal(authFetch.calls.length, 1)
    assert.equal(authFetch.calls[0].path, '/practice/summary')
  })
  it('loadSummary 响应非 ok 时返回空对象', async () => {
    const authFetch = makeAuthFetch(() => Promise.resolve({ ok: false }))
    assert.deepEqual(await loadSummary(authFetch, false), {})
  })
  it('loadSummary 请求失败时返回空对象', async () => {
    const authFetch = makeAuthFetch(() => Promise.reject(new Error('network')))
    assert.deepEqual(await loadSummary(authFetch, false), {})
  })

  it('loadOne 请求 /practice/:id 并合并到空结构', async () => {
    const authFetch = makeAuthFetch(okJson({ data: { shadow: [1, 2] } }))
    const data = await loadOne(authFetch, false, 'v1')
    assert.deepEqual(data, { shadow: [1, 2], cloze: [], translate: [] })
    assert.equal(authFetch.calls[0].path, '/practice/v1')
  })
  it('loadOne 响应非 ok 时返回空结构', async () => {
    const authFetch = makeAuthFetch(() => Promise.resolve({ ok: false }))
    assert.deepEqual(await loadOne(authFetch, false, 'v1'), emptyPracticeData())
  })
  it('loadOne 请求失败时返回空结构', async () => {
    const authFetch = makeAuthFetch(() => Promise.reject(new Error('network')))
    assert.deepEqual(await loadOne(authFetch, false, 'v1'), emptyPracticeData())
  })

  it('mark 向 /practice/:id 发送 POST 与任务负载', async () => {
    const authFetch = makeAuthFetch(okJson({}))
    mark(authFetch, false, 'v1', 'cloze', 3)
    await new Promise(r => setTimeout(r, 0))
    assert.equal(authFetch.calls.length, 1)
    const { path, options } = authFetch.calls[0]
    assert.equal(path, '/practice/v1')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { task: 'cloze', index: 3 })
  })
  it('mark 请求失败时不抛错（乐观记录）', async () => {
    const authFetch = makeAuthFetch(() => Promise.reject(new Error('network')))
    assert.doesNotThrow(() => mark(authFetch, false, 'v1', 'cloze', 3))
    // 让被吞掉的 rejection 结算，若未捕获会在这里冒泡
    await new Promise(r => setTimeout(r, 0))
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
