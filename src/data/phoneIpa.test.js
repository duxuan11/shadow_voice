import test from 'node:test'
import assert from 'node:assert/strict'
import { stripStress, toIPA, isConsonant, isVowel } from './phoneIpa.js'

test('stripStress 剥离重音前缀', () => {
  assert.equal(stripStress("'p"), 'p')
  assert.equal(stripStress('p'), 'p')
  assert.equal(stripStress(''), '')
  assert.equal(stripStress(null), '')
})

test('toIPA 覆盖实测混合符号集', () => {
  assert.equal(toIPA('ay'), 'aɪ')
  assert.equal(toIPA('aɪ'), 'aɪ')      // 别名归一
  assert.equal(toIPA('aa'), 'ɑ')
  assert.equal(toIPA('aw'), 'aʊ')
  assert.equal(toIPA('ax'), 'ə')
  assert.equal(toIPA('iy'), 'i')
  assert.equal(toIPA('uw'), 'u')
  assert.equal(toIPA("'p"), 'p')       // 实测 possible 首音素
  assert.equal(toIPA('ɪə'), 'ɪə')
})

test('toIPA 未收录符号原样返回（降级不崩）', () => {
  assert.equal(toIPA('zzz'), 'zzz')
})

test('辅音/元音分类', () => {
  assert.equal(isConsonant('t'), true)
  assert.equal(isVowel('aw'), true)
  assert.equal(isVowel('aʊ'), true)
  assert.equal(isConsonant('aw'), false)
  assert.equal(isVowel('t'), false)
  assert.equal(isConsonant('zzz'), false)   // 未知不算辅音
  assert.equal(isVowel('zzz'), false)       // 未知不算元音
})
