import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResult } from './aliyunResult.js'

const sample = JSON.stringify({
  result: {
    overall: 86,
    accuracy: 92,
    integrity: 100,
    fluency: { overall: 78, pause: 3, speed: 1 },
    rhythm: { overall: 71, sense: 70, stress: 80, tone: 62 },
    details: [
      { char: 'I', score: 95, start: 0, end: 100, dur: 100 },
      {
        char: 'want', score: 60, start: 100, end: 300, dur: 200,
        liaisonref: 1, liaisonscore: 0,
        stressref: 1, stressscore: 1,
        toneref: 0, tonescore: 0,
        senseref: 0, sensescore: 0,
        phone: [
          { char: 'w', score: 90, pherr: 0, ph2alpha: 'w' },
          { char: 'aa', score: 45, pherr: 1, ph2alpha: 'a' },
        ],
      },
      {
        char: 'to', score: 88, start: 300, end: 420, dur: 120,
        liaisonref: 1, liaisonscore: 1,
        dp_type: 2,
      },
      { char: 'OOVword', score: 0, start: 420, end: 500, dur: 80, fake_pron: 1 },
    ],
    info: { tipId: 10004, snr: 20, clip: 0, volume: 40 },
  },
  audioUrl: 'http://files.cloud.ssapi.cn/a148/abc123',
})

test('完整样例：所有字段归一化正确', () => {
  const r = parseResult(sample)
  assert.equal(r.overall, 86)
  assert.equal(r.accuracy, 92)
  assert.equal(r.integrity, 100)
  assert.deepEqual(r.fluency, { overall: 78, pause: 3, speed: 1 })
  assert.deepEqual(r.rhythm, { overall: 71, sense: 70, stress: 80, tone: 62 })
  assert.equal(r.liaison.expected, 2)
  assert.equal(r.liaison.ok, 1)
  assert.equal(r.words.length, 4)
  assert.equal(r.audioUrl, 'http://files.cloud.ssapi.cn/a148/abc123')
  assert.equal(r.tipId, 10004)
})

test('单词字段：连读/重读/漏读/音素/集外词', () => {
  const r = parseResult(sample)
  const want = r.words[1]
  assert.deepEqual(want.liaison, { ref: 1, score: 0 })
  assert.deepEqual(want.stress, { ref: 1, score: 1 })
  assert.equal(want.phones.length, 2)
  assert.equal(want.phones[1].pherr, 1)
  assert.equal(want.phones[1].ph2alpha, 'a')
  const to = r.words[2]
  assert.equal(to.dpType, 2)
  assert.equal(r.words[3].fakePron, true)
})

test('空 details / 缺字段不抛异常', () => {
  const r1 = parseResult(JSON.stringify({ result: {} }))
  assert.deepEqual(r1.words, [])
  assert.equal(r1.overall, null)
  assert.equal(r1.accuracy, null)
  assert.equal(r1.liaison.expected, 0)
  const r2 = parseResult('{}')
  assert.deepEqual(r2.words, [])
})

test('对象入参与字符串入参等价', () => {
  const asObj = parseResult(JSON.parse(sample))
  const asStr = parseResult(sample)
  assert.deepEqual(asObj, asStr)
})

test('audioUrl 缺失时按 applicationId/recordId 拼接（SDK 约定）', () => {
  const r = parseResult(JSON.stringify({
    applicationId: 'a148',
    recordId: '11ec05b74ec73b88a52ea1484261e844',
    result: { details: [] },
  }))
  assert.equal(r.audioUrl, 'https://files.cloud.ssapi.cn/a148/11ec05b74ec73b88a52ea1484261e844.mp3')
  assert.equal(r.words.length, 0)
  assert.equal(r.overall, null)
})
