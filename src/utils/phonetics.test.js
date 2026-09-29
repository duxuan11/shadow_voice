import test from 'node:test'
import assert from 'node:assert/strict'

import { getPhonetic } from './phonetics.js'

test('getPhonetic：命中常见词，返回斜杠包裹的 IPA', () => {
  const ipa = getPhonetic('experience')
  assert.match(ipa, /^\/.*\/$/)
  assert.ok(ipa.includes('ɪk'), `期望含 ɪk，实际 ${ipa}`)
})

test('getPhonetic：大小写不敏感、去首尾标点', () => {
  assert.equal(getPhonetic('  Check! '), getPhonetic('check'))
})

test('getPhonetic：短语/空值/未知词返回空串', () => {
  assert.equal(getPhonetic('check in'), '')
  assert.equal(getPhonetic(''), '')
  assert.equal(getPhonetic(null), '')
  assert.equal(getPhonetic('zzzzqqqnotaword'), '')
})
