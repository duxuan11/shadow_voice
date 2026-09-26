// 词卡构建 util 回归测试：
// 重点在「AI 只给词/释义，时间戳与频次由本地字幕回填；扫不到的条目丢弃」。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, countKeyword, locatePhrase, buildWordcard } from './wordcard.js'

const sub = (textEn, startTime, textCn = '') => ({ textEn, textCn, startTime, endTime: startTime + 1 })

describe('normalizeText', () => {
  it('忽略大小写、标点与多余空白', () => {
    assert.equal(normalizeText("Check-in, please!"), 'check in please')
    assert.equal(normalizeText("  You're  "), "you're")
  })
})

describe('countKeyword', () => {
  const subs = [sub('Book a flight', 1), sub('I booked the flight and a hotel', 5), sub('Flight ticket', 9)]

  it('整词匹配、忽略大小写与标点', () => {
    assert.deepEqual(countKeyword(subs, 'flight'), { count: 3, times: [1, 5, 9] })
    assert.deepEqual(countKeyword(subs, 'a'), { count: 2, times: [1, 5] })
  })

  it('不把 booked 当成 book（避免误命中）', () => {
    assert.deepEqual(countKeyword(subs, 'book'), { count: 1, times: [1] })
  })

  it('无命中返回 0 / 空数组', () => {
    assert.deepEqual(countKeyword(subs, 'airport'), { count: 0, times: [] })
    assert.deepEqual(countKeyword(subs, ''), { count: 0, times: [] })
  })
})

describe('locatePhrase', () => {
  const subs = [sub('You have to check in your bag', 127.5, '你要托运'), sub('Check in again', 200)]

  it('定位首次出现并带回例句', () => {
    const loc = locatePhrase(subs, 'check in')
    assert.equal(loc.startTime, 127.5)
    assert.equal(loc.count, 2)
    assert.equal(loc.sentenceEn, 'You have to check in your bag')
    assert.equal(loc.sentenceCn, '你要托运')
  })

  it('忽略标点/大小写', () => {
    assert.equal(locatePhrase(subs, 'Check-in').startTime, 127.5)
  })

  it('找不到返回 null', () => {
    assert.equal(locatePhrase(subs, 'no such phrase'), null)
    assert.equal(locatePhrase(subs, ''), null)
  })
})

describe('buildWordcard', () => {
  const subs = [
    sub('Book a flight ticket when you book a flight ticket', 61.233, '你需要提前订好机票'),
    sub('You reserve the seat for example', 65.133, '你就是在预订座位'),
    sub('You have to check in your bag with your airline', 127.5, '要去柜台托运'),
  ]
  const ai = {
    keywords: [
      { word: 'flight', meaning: '航班' },
      { word: 'seat', meaning: '座位' },
      { word: 'nonsense', meaning: '不存在的词' },
      { word: 'flight', meaning: '重复项' },
    ],
    phrases: [
      { text: 'check in', meaning: '办理登机/托运' },
      { text: 'not in transcript', meaning: '应被丢弃' },
      { text: 'reserve the seat', meaning: '预订座位' },
    ],
    expressions: [
      { textEn: 'You reserve the seat for example', meaning: '例如你预订座位' },
      { textEn: 'Missing sentence', meaning: '应被丢弃' },
    ],
  }

  it('回填频次/时间，丢弃扫不到的条目，去重并排序', () => {
    const wc = buildWordcard(subs, ai, { videoId: 'v1', model: 'test' })
    assert.equal(wc.version, 1)
    assert.equal(wc.videoId, 'v1')

    assert.deepEqual(wc.keywords.map((k) => k.word), ['flight', 'seat'])
    assert.equal(wc.keywords[0].count, 2)
    assert.equal(wc.keywords[0].times[0], 61.233)
    assert.equal(wc.keywords[0].meaning, '航班')

    // 频次相同则按首现时间升序：reserve(65.133) 在前
    assert.deepEqual(wc.phrases.map((p) => p.text), ['reserve the seat', 'check in'])
    assert.equal(wc.phrases[1].startTime, 127.5)
    assert.equal(wc.phrases[1].sentenceCn, '要去柜台托运')

    assert.equal(wc.expressions.length, 1)
    assert.equal(wc.expressions[0].textCn, '你就是在预订座位')
    assert.equal(wc.expressions[0].startTime, 65.133)
  })

  it('空 / 非法输入安全返回空词卡', () => {
    const wc = buildWordcard([], null)
    assert.deepEqual(wc.keywords, [])
    assert.deepEqual(wc.phrases, [])
    assert.deepEqual(wc.expressions, [])
  })
})
