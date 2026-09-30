import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, tokenize, checkSpelling, isAllCorrect } from './spellCheck.js'

test('tokenize：去标点、合并空白、保留缩写撇号', () => {
  assert.deepEqual(tokenize("Check in, please!"), ['Check', 'in', 'please'])
  assert.deepEqual(tokenize("I don't know"), ['I', "don't", 'know'])
  assert.deepEqual(tokenize('  '), [])
})

test('checkSpelling：全对', () => {
  const r = checkSpelling('I want to check in', 'I want to check in')
  assert.deepEqual(r.map(x => x.type), ['correct', 'correct', 'correct', 'correct', 'correct'])
  assert.equal(isAllCorrect(r), true)
})

test('checkSpelling：错误（user vs expected）', () => {
  const r = checkSpelling('I want too check in', 'I want to check in')
  assert.deepEqual(r[2], { type: 'wrong', user: 'too', expected: 'to' })
  assert.equal(isAllCorrect(r), false)
})

test('checkSpelling：遗漏（末尾少词）', () => {
  const r = checkSpelling('I want to', 'I want to check in')
  assert.deepEqual(r.slice(3), [
    { type: 'missing', expected: 'check' },
    { type: 'missing', expected: 'in' },
  ])
})

test('checkSpelling：多余（末尾多词）', () => {
  const r = checkSpelling('I want to check in now', 'I want to check in')
  assert.deepEqual(r[5], { type: 'extra', user: 'now' })
})

test('checkSpelling：大小写不敏感', () => {
  const r = checkSpelling('CHECK IN', 'check in')
  assert.equal(isAllCorrect(r), true)
})

test('normalizeText：只保留单词字符、空格、连字符、撇号', () => {
  assert.equal(normalizeText('Hello — world!'), 'Hello world')
})
