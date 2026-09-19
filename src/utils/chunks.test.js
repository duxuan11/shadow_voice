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
