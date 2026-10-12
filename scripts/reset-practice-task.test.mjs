import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clearTaskInData } from './reset-practice-task.mjs'

describe('clearTaskInData', () => {
  it('清掉指定任务，其余任务不动', () => {
    const r = clearTaskInData(JSON.stringify({ shadow: [1, 2], cloze: [], translate: [], speak: [0, 1, 2] }), 'speak')
    assert.equal(r.changed, true)
    assert.deepEqual(JSON.parse(r.json), { shadow: [1, 2], cloze: [], translate: [], speak: [] })
  })
  it('已经为空 → 不改', () => {
    const r = clearTaskInData(JSON.stringify({ shadow: [1], speak: [] }), 'speak')
    assert.equal(r.changed, false)
  })
  it('缺该任务 / 非数组 → 不改', () => {
    assert.equal(clearTaskInData(JSON.stringify({ shadow: [1] }), 'speak').changed, false)
    assert.equal(clearTaskInData(JSON.stringify({ speak: null }), 'speak').changed, false)
  })
  it('非法 JSON / 非对象不抛错', () => {
    assert.equal(clearTaskInData('not json', 'speak').changed, false)
    assert.equal(clearTaskInData(null, 'speak').changed, false)
  })
})
