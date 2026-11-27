import test from 'node:test'
import assert from 'node:assert/strict'
import { accentToEvalParam } from './accentParam.js'

test('美音 / 英音 / 未知', () => {
  assert.equal(accentToEvalParam('美音'), 'am')
  assert.equal(accentToEvalParam('US'), 'am')
  assert.equal(accentToEvalParam('American English'), 'am')
  assert.equal(accentToEvalParam('英音'), 'en')
  assert.equal(accentToEvalParam('uk'), 'en')
  assert.equal(accentToEvalParam('British'), 'en')
  assert.equal(accentToEvalParam('澳洲'), null)
  assert.equal(accentToEvalParam(''), null)
  assert.equal(accentToEvalParam(undefined), null)
  assert.equal(accentToEvalParam(null), null)
  assert.equal(accentToEvalParam(42), null)
})
