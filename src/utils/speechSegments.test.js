import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRestartSegment } from './speechSegments.js'

test('只有「分段 + Web Speech + 仍在听」才续识', () => {
  assert.equal(shouldRestartSegment({ segmented: true, source: 'web', listening: true }), true)
  assert.equal(shouldRestartSegment({ segmented: false, source: 'web', listening: true }), false)
  assert.equal(shouldRestartSegment({ segmented: true, source: 'aliyun', listening: true }), false)
  assert.equal(shouldRestartSegment({ segmented: true, source: 'web', listening: false }), false)
})
