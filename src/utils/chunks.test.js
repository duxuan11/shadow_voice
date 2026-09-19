// 语块提取 util 回归测试：句首框架命中、具体规则优先、大小写、边界、不误伤。
// 背景：词卡「核心短语」原来把整句字幕原样列出，改为本地规则抽可迁移语块。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractChunks } from './chunks.js'

const sub = (textEn, startTime, extra = {}) => ({
  id: String(startTime), startTime, endTime: startTime + 2, textEn, textCn: '', ...extra,
})

describe('extractChunks - 句首框架', () => {
  it('抽出 It turns out that... 并带模板释义与源句', () => {
    const out = extractChunks([
      sub('It turns out that the problem is much more complicated than we thought.', 12.3, {
        textCn: '结果发现，问题比我们想的复杂得多。',
      }),
    ])
    const opener = out.find(c => c.type === 'opener')
    assert.equal(opener.text, 'It turns out that...')
    assert.equal(opener.gloss, '结果（发现）……')
    assert.equal(opener.startTime, 12.3)
    assert.equal(opener.sentenceEn, 'It turns out that the problem is much more complicated than we thought.')
    assert.equal(opener.sentenceCn, '结果发现，问题比我们想的复杂得多。')
  })

  it('更具体的 gonna 框架优先于泛化的 I don\'t think', () => {
    const out = extractChunks([sub("I don't think we're gonna see that anytime soon.", 5)])
    const openers = out.filter(c => c.type === 'opener').map(c => c.text)
    assert.deepEqual(openers, ["I don't think we're gonna..."])
  })

  it('大小写不敏感，语块文本保留源字幕大小写', () => {
    const out = extractChunks([sub('it turns out that he lied', 0)])
    assert.equal(out[0].text, 'it turns out that...')
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(extractChunks([]), [])
    assert.deepEqual(extractChunks(undefined), [])
    assert.deepEqual(extractChunks(null), [])
  })

  it('不含规则的普通句不产出语块', () => {
    assert.deepEqual(extractChunks([sub('I saw a movie yesterday.', 0)]), [])
  })
})

describe('extractChunks - 句尾补充与程度比较', () => {
  it('例 1 同时抽出句首框架与句尾补充', () => {
    const out = extractChunks([sub("I don't think we're gonna see that anytime soon.", 5)])
    assert.deepEqual(
      out.map(c => c.text).sort(),
      ["I don't think we're gonna...", '...anytime soon'].sort()
    )
  })

  it('例 2 同时抽出句首框架与程度比较', () => {
    const out = extractChunks([sub('It turns out that the problem is much more complicated than we thought.', 0)])
    assert.deepEqual(
      out.map(c => c.text).sort(),
      ['It turns out that...', 'much more complicated than...'].sort()
    )
  })

  it('同一句最多 2 个语块（degree 优先于 tail）', () => {
    const out = extractChunks([sub('It turns out that she is much more careful than me right now.', 0)])
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(c => c.type).sort(), ['degree', 'opener'])
  })

  it('同一语块多次出现合并为一条并计数，startTime 取首次', () => {
    const out = extractChunks([
      sub("I don't think we're gonna win.", 3),
      sub('It turns out that he won.', 9),
      sub('It turns out that she lost.', 12),
    ])
    const openers = out.filter(c => c.text === 'It turns out that...')
    assert.equal(openers.length, 1)
    assert.equal(openers[0].count, 2)
    assert.equal(openers[0].startTime, 9)
  })

  it('count 降序、其次 startTime 升序', () => {
    const out = extractChunks([
      sub("I don't think we're gonna win.", 3),
      sub('It turns out that he won.', 9),
      sub('It turns out that she lost.', 12),
    ])
    assert.equal(out[0].text, 'It turns out that...')
    assert.equal(out[0].count, 2)
    assert.equal(out[1].startTime, 3)
  })

  it('as soon as 不会被 as...as 误判为程度比较', () => {
    assert.deepEqual(extractChunks([sub('Please call me as soon as possible.', 0)]), [])
  })

  it('句尾补充可独立命中（无句首框架时）', () => {
    const out = extractChunks([sub('I will finish it for now.', 0)])
    assert.deepEqual(out.map(c => c.text), ['...for now'])
  })
})
