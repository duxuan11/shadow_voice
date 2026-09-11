// 字幕清洗 util 回归测试：合并相邻重复句，保留非相邻重复、去标点大小写匹配、不修改入参。
// 背景：源字幕里存在“相邻两条英文完全相同”的记录（同一句被拆成两段连续时间轴），
// 前端逐句练习（跟读/填空/中译英/听写）会看到同一句连着出现两次。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAdjacentDuplicateSubtitles, normalizeSentence } from './subtitles.js'

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
