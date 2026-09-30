import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitToSlots, slotCountFor, compareSlots, distributePaste, joinSlots, slotsAllCorrect,
} from './spellSlots.js'

test('splitToSlots / slotCountFor：去标点、合并空白、至少 1 槽', () => {
  assert.deepEqual(splitToSlots('It turns out that ...'), ['It', 'turns', 'out', 'that'])
  assert.equal(slotCountFor('check in'), 2)
  assert.equal(slotCountFor(''), 1)
})

test('compareSlots：correct / wrong / missing', () => {
  const r = compareSlots(['check', '', 'nope'], ['check', 'in', 'now'])
  assert.deepEqual(r.map(x => x.status), ['correct', 'missing', 'wrong'])
  assert.equal(r[2].expected, 'now')
  assert.equal(r[1].expected, 'in')
})

test('compareSlots：大小写与标点不敏感', () => {
  const r = compareSlots(['Check-in'], ['check in'])
  assert.equal(r.length, 1)
  assert.equal(r[0].status, 'wrong') // 连字符保留：'Check-in' 归一为 'check-in' != 'check in'
  assert.equal(compareSlots(['CHECK'], ['check'])[0].status, 'correct')
})

test('distributePaste：从中间开始，超出并入末槽', () => {
  assert.deepEqual(distributePaste('a b c', 2, 0), ['a', 'b c'])
  assert.deepEqual(distributePaste('x y', 3, 1), ['', 'x', 'y'])
  assert.deepEqual(distributePaste('  one   two  ', 2, 0, ['base', '']), ['one', 'two'])
  // base 中未被粘贴覆盖的槽保持原值
  assert.deepEqual(distributePaste('z', 3, 1, ['a', 'b', 'c']), ['a', 'z', 'c'])
  // 超出槽数时并入末槽，且保留末槽原值
  assert.deepEqual(distributePaste('q r', 2, 0, ['', 'b']), ['q', 'b r'])
})

test('joinSlots：拼接并去尾空白', () => {
  assert.equal(joinSlots(['check', '', 'in']), 'check  in')
  assert.equal(joinSlots(['a', 'b']), 'a b')
})

test('slotsAllCorrect', () => {
  assert.equal(slotsAllCorrect([{ status: 'correct' }]), true)
  assert.equal(slotsAllCorrect([{ status: 'correct' }, { status: 'wrong' }]), false)
  assert.equal(slotsAllCorrect([]), false)
})
