// 字幕清洗 util 回归测试：合并相邻重复句，保留非相邻重复、去标点大小写匹配、不修改入参。
// 背景：源字幕里存在“相邻两条英文完全相同”的记录（同一句被拆成两段连续时间轴），
// 前端逐句练习（跟读/填空/中译英/听写）会看到同一句连着出现两次。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAdjacentDuplicateSubtitles, normalizeSentence, findActiveSubtitleIndex } from './subtitles.js'

const sub = (textEn, startTime, endTime, extra = {}) => ({ id: `${startTime}`, startTime, endTime, textEn, textCn: '', ...extra })

describe('normalizeSentence', () => {
  it('忽略大小写、标点与多余空白', () => {
    assert.equal(normalizeSentence("She's a chic chick"), normalizeSentence("  she's a chic, chick! "))
    assert.equal(normalizeSentence('This is called a wheel.'), 'this is called a wheel')
  })
})

describe('mergeAdjacentDuplicateSubtitles', () => {
  it('没有重复时原样返回（内容相同的新数组）', () => {
    const subs = [sub('Hello there', 0, 1), sub('How are you', 1, 2)]
    const out = mergeAdjacentDuplicateSubtitles(subs)
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(s => s.textEn), ['Hello there', 'How are you'])
  })

  it('相邻同句合并为一条，endTime 取并集（不丢音频）', () => {
    const subs = [sub('This is called a wheel', 28.74, 30.683), sub('This is called a wheel', 30.733, 31.825), sub('Next line', 32, 33)]
    const out = mergeAdjacentDuplicateSubtitles(subs)
    assert.equal(out.length, 2)
    assert.equal(out[0].textEn, 'This is called a wheel')
    assert.equal(out[0].startTime, 28.74)
    assert.equal(out[0].endTime, 31.825)
    assert.equal(out[0].id, '28.74') // 保留第一条的 id
    assert.equal(out[1].textEn, 'Next line')
  })

  it('连续 3 次以上也合并成一条', () => {
    const subs = [sub("She's a chic chick", 733.821, 736.283), sub("She's a chic chick", 736.333, 737.318), sub("She's a chic chick", 737.318, 737.97)]
    const out = mergeAdjacentDuplicateSubtitles(subs)
    assert.equal(out.length, 1)
    assert.equal(out[0].endTime, 737.97)
  })

  it('大小写/标点不同视为同句', () => {
    const subs = [sub('Hello, world!', 0, 1), sub('hello world', 1, 2)]
    assert.equal(mergeAdjacentDuplicateSubtitles(subs).length, 1)
  })

  it('非相邻的重复句不合并（同句隔了别的句子属于正常内容）', () => {
    const subs = [sub('Yeah', 0, 1), sub('I know', 1, 2), sub('Yeah', 2, 3)]
    assert.equal(mergeAdjacentDuplicateSubtitles(subs).length, 3)
  })

  it('空 textEn 不参与合并', () => {
    const subs = [sub('', 0, 1), sub('', 1, 2)]
    assert.equal(mergeAdjacentDuplicateSubtitles(subs).length, 2)
  })

  it('第一条缺中文时用重复条目的中文补齐', () => {
    const subs = [sub('Hi', 0, 1), sub('Hi', 1, 2, { textCn: '你好' })]
    const out = mergeAdjacentDuplicateSubtitles(subs)
    assert.equal(out.length, 1)
    assert.equal(out[0].textCn, '你好')
  })

  it('不修改入参数组与对象', () => {
    const subs = [sub('Hi', 0, 1), sub('Hi', 1, 2)]
    const snapshot = JSON.stringify(subs)
    mergeAdjacentDuplicateSubtitles(subs)
    assert.equal(JSON.stringify(subs), snapshot)
  })

  it('空/非数组输入安全返回', () => {
    assert.deepEqual(mergeAdjacentDuplicateSubtitles([]), [])
    assert.deepEqual(mergeAdjacentDuplicateSubtitles(null), [])
    assert.deepEqual(mergeAdjacentDuplicateSubtitles(undefined), [])
  })
})

describe('findActiveSubtitleIndex', () => {
  const subs = [
    { startTime: 0, endTime: 2, textEn: 'A' },
    { startTime: 3, endTime: 5, textEn: 'B' },
    { startTime: 6, endTime: 8, textEn: 'C' },
  ]

  it('时间落在某句区间内时返回该句下标（含 start/end 边界）', () => {
    assert.equal(findActiveSubtitleIndex(subs, 1), 0)
    assert.equal(findActiveSubtitleIndex(subs, 3), 1)
    assert.equal(findActiveSubtitleIndex(subs, 4), 1)
    assert.equal(findActiveSubtitleIndex(subs, 8), 2)
  })

  it('落在间隙或区间外返回 -1', () => {
    assert.equal(findActiveSubtitleIndex(subs, -1), -1)
    assert.equal(findActiveSubtitleIndex(subs, 2.5), -1)
    assert.equal(findActiveSubtitleIndex(subs, 99), -1)
  })

  it('时间轴重叠时取最后一条命中（点下一句不再退回上一句）', () => {
    const overlap = [
      { startTime: 10, endTime: 12, textEn: 'A' },
      { startTime: 11.5, endTime: 13, textEn: 'B' },
      { startTime: 13.5, endTime: 15, textEn: 'C' },
    ]
    // 跳到 B 的起点 11.5 时同时命中 A 与 B，应选后开始的 B
    assert.equal(findActiveSubtitleIndex(overlap, 11.5), 1)
    assert.equal(findActiveSubtitleIndex(overlap, 11.9), 1)
    // A 独占区间仍选 A
    assert.equal(findActiveSubtitleIndex(overlap, 10.5), 0)
  })

  it('空 / 非数组输入安全返回 -1', () => {
    assert.equal(findActiveSubtitleIndex([], 0), -1)
    assert.equal(findActiveSubtitleIndex(null, 0), -1)
    assert.equal(findActiveSubtitleIndex(undefined, 5), -1)
  })
})
