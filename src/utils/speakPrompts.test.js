import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterSubtitlesToPrompts, buildSpeakPromptsData } from './speakPrompts.js'

describe('filterSubtitlesToPrompts', () => {
  it('非数组 / 空数组 → []', () => {
    assert.deepEqual(filterSubtitlesToPrompts(null), [])
    assert.deepEqual(filterSubtitlesToPrompts([]), [])
  })
  it('剔除空/短/单词/无中文/无字母', () => {
    const subs = [
      { textEn: 'We checked in today.', textCn: '我们今天办理了入住。' },     // keep
      { textEn: 'Hi', textCn: '嗨' },                                        // cn<4 且 en 单词
      { textEn: '', textCn: '空的英文' },                                     // en 空
      { textEn: 'Nice view', textCn: '' },                                   // cn 空
      { textEn: '123 456', textCn: '一二三四五六' },                          // en 无字母
      { textEn: 'The concierge took our bags.', textCn: '礼宾员拿了行李。' }, // keep
    ]
    assert.deepEqual(filterSubtitlesToPrompts(subs), [
      { cn: '我们今天办理了入住。', en: 'We checked in today.', source: 'subtitle', subIndex: 0 },
      { cn: '礼宾员拿了行李。', en: 'The concierge took our bags.', source: 'subtitle', subIndex: 5 },
    ])
  })
  it('上限 maxPrompts 截断', () => {
    const subs = Array.from({ length: 10 }, (_, i) => ({ textEn: `This is sentence ${i} here.`, textCn: `这是第${i}个句子。` }))
    assert.equal(filterSubtitlesToPrompts(subs, { maxPrompts: 3 }).length, 3)
  })
  it('总数始终小于字幕数（全部适合时也截掉）', () => {
    const subs = Array.from({ length: 5 }, (_, i) => ({ textEn: `This is sentence ${i} here.`, textCn: `这是第${i}个句子。` }))
    assert.equal(filterSubtitlesToPrompts(subs).length, 4)
  })
})

describe('buildSpeakPromptsData', () => {
  it('组装 index/version/title/generatedAt', () => {
    const data = buildSpeakPromptsData({
      videoId: 'v1', title: '测试', generatedAt: '2026-10-11T00:00:00Z',
      subtitlePrompts: [{ cn: 'a', en: 'A', source: 'subtitle', subIndex: 3 }],
      extensionPrompts: [{ cn: 'b', en: 'B', source: 'ai_generated', subIndex: null }],
    })
    assert.equal(data.version, 1)
    assert.equal(data.videoId, 'v1')
    assert.deepEqual(data.prompts.map(p => p.index), [0, 1])
    assert.deepEqual(data.prompts[0], { index: 0, cn: 'a', en: 'A', source: 'subtitle', subIndex: 3 })
    assert.deepEqual(data.prompts[1], { index: 1, cn: 'b', en: 'B', source: 'ai_generated', subIndex: null })
  })
})
