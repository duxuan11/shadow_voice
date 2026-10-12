import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { subtitleCapFor, filterSubtitlesToPrompts, normalizeSpeakPrompts, promptBadges, extractionVerdict, buildSpeakPromptsData } from './speakPrompts.js'

describe('subtitleCapFor', () => {
  it('40 行 → 20（用户例子：40 条字幕出 20 句左右）', () => {
    assert.equal(subtitleCapFor(40), 20)
  })
  it('短视频按比例：22 → 11、26 → 13、35 → 18', () => {
    assert.equal(subtitleCapFor(22), 11)
    assert.equal(subtitleCapFor(26), 13)
    assert.equal(subtitleCapFor(35), 18)
  })
  it('封顶 20：334 → 20', () => {
    assert.equal(subtitleCapFor(334), 20)
  })
  it('下限 5：10 → 5、2 → 5', () => {
    assert.equal(subtitleCapFor(10), 5)
    assert.equal(subtitleCapFor(2), 5)
  })
  it('空/非法 → 0', () => {
    assert.equal(subtitleCapFor(0), 0)
    assert.equal(subtitleCapFor(-3), 0)
    assert.equal(subtitleCapFor(null), 0)
  })
})

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
      { cn: '我们今天办理了入住。', en: 'We checked in today.', source: 'subtitle', level: null, subIndex: 0 },
      { cn: '礼宾员拿了行李。', en: 'The concierge took our bags.', source: 'subtitle', level: null, subIndex: 5 },
    ])
  })
  it('上限 maxPrompts 截断', () => {
    const subs = Array.from({ length: 10 }, (_, i) => ({ textEn: `This is sentence ${i} here.`, textCn: `这是第${i}个句子。` }))
    assert.equal(filterSubtitlesToPrompts(subs, { maxPrompts: 3 }).length, 3)
  })
})

describe('filterSubtitlesToPrompts 兜底上限', () => {
  const subs = Array.from({ length: 40 }, (_, i) => ({
    textEn: `This is sentence number ${i}.`,
    textCn: `这是第${i}个句子。`,
  }))
  it('默认按 subtitleCapFor 截断（40 行 → 20），不再是固定 40', () => {
    assert.equal(filterSubtitlesToPrompts(subs).length, 20)
  })
  it('产出的每条都带 level: null（页面据此不显示难度标签）', () => {
    assert.deepEqual(filterSubtitlesToPrompts(subs, { maxPrompts: 2 })[0], {
      cn: '这是第0个句子。', en: 'This is sentence number 0.', source: 'subtitle', level: null, subIndex: 0,
    })
  })
})

describe('buildSpeakPromptsData', () => {
  const data = () => buildSpeakPromptsData({
    videoId: 'v1', title: '出国旅行的日常', level: '初级', model: 'deepseek-chat',
    generatedAt: '2026-10-12T00:00:00Z',
    subtitlePrompts: [
      { cn: '这个东西是行李推车，用来放行李的。', en: 'This is a luggage trolley.', level: '简单', subIndex: 2, subIndexEnd: 4 },
      { cn: '字幕句但漏了行号。', en: 'No line numbers.', level: null, subIndex: null, subIndexEnd: null },
    ],
    extensionPrompts: [
      { cn: '我订了一间带早餐的房间。', en: 'I booked a room with breakfast included.', level: '中等' },
    ],
  })

  it('version 2 + 顶层字段透传', () => {
    const d = data()
    assert.equal(d.version, 2)
    assert.equal(d.videoId, 'v1')
    assert.equal(d.level, '初级')
    assert.equal(d.model, 'deepseek-chat')
  })

  it('source 由数组归属决定（漏行号的字幕句仍是 subtitle）', () => {
    assert.deepEqual(data().prompts.map(p => p.source), ['subtitle', 'subtitle', 'ai_generated'])
  })

  it('index 连续、扩展句 subIndex/subIndexEnd 为 null、level 透传', () => {
    const p = data().prompts
    assert.deepEqual(p.map(x => x.index), [0, 1, 2])
    assert.deepEqual(p[0], {
      index: 0, cn: '这个东西是行李推车，用来放行李的。', en: 'This is a luggage trolley.',
      source: 'subtitle', level: '简单', subIndex: 2, subIndexEnd: 4,
    })
    assert.deepEqual(p[2], {
      index: 2, cn: '我订了一间带早餐的房间。', en: 'I booked a room with breakfast included.',
      source: 'ai_generated', level: '中等', subIndex: null, subIndexEnd: null,
    })
  })
})

describe('normalizeSpeakPrompts', () => {
  const raw = () => ({
    sentences: [
      { lines: [9, 9], cn: '通常礼宾员会帮你拿行李。', en: 'Normally the concierge takes your bags.', level: '中等' },
      { lines: [3, 5], cn: '这个东西是行李推车，用来放行李的。', en: 'This is a luggage trolley, where you put your bags.', level: '简单' },
      { cn: '字幕句但模型漏了行号。', en: 'A sentence with no line numbers.', level: '很难' },
      { lines: ['x', 999], cn: '行号越界或非整数。', en: 'Lines out of range.', level: '难' },
      { cn: '', en: 'Empty cn.' },
      { cn: '没有英文。', en: '' },
      { cn: 'English only', en: 'no cjk here' },
      { cn: '词太少。', en: 'too' },
    ],
    extensions: [
      { cn: '我订了一间带早餐的房间。', en: 'I booked a room with breakfast included.', level: '中等' },
      { cn: '行李可以寄存在前台。', en: 'You can leave your luggage at the front desk.', level: '困难' },
    ],
  })

  it('空/畸形输入不抛错 → 空数组 + 告警', () => {
    const r = normalizeSpeakPrompts(null, { subtitleCount: 3, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts, [])
    assert.deepEqual(r.extensionPrompts, [])
    assert.equal(r.stats.subtitle, 0)
    assert.ok(r.warnings.includes('没有可用的字幕句'))
  })

  it('丢弃空/无中文/无英文/词数不足的条目', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.cn), [
      '这个东西是行李推车，用来放行李的。',
      '通常礼宾员会帮你拿行李。',
      '字幕句但模型漏了行号。',
      '行号越界或非整数。',
    ])
    assert.equal(r.stats.dropped, 4)
  })

  it('排序：按 subIndex 升序，漏行号的排在其后', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.subIndex), [2, 8, null, null])
    assert.deepEqual(r.subtitlePrompts.map(p => p.subIndexEnd), [4, 8, null, null])
  })

  it('level：非法值回落到 targetLevel，targetLevel 也非法则 null', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '中等' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.level), ['简单', '中等', '中等', '难'])
    const r2 = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '超难' })
    assert.deepEqual(r2.subtitlePrompts.map(p => p.level), ['简单', '中等', null, '难'])
  })

  it('漏行号的字幕句留在字幕句里（不会被当成扩展句）', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.ok(r.subtitlePrompts.some(p => p.cn === '字幕句但模型漏了行号。'))
    assert.ok(!r.extensionPrompts.some(p => p.cn === '字幕句但模型漏了行号。'))
  })

  it('截断：cap 先排序再截断，留下视频靠前的句子', () => {
    const r = normalizeSpeakPrompts(raw(), { cap: 2, subtitleCount: 10, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.subIndex), [2, 8])
  })

  it('去重：cn 归一化后相同只留第一条（去空白与标点）', () => {
    const r = normalizeSpeakPrompts({
      sentences: [
        { lines: [1], cn: '你好，世界。', en: 'Hello world today.' },
        { lines: [2], cn: ' 你好世界 ', en: 'Hello, world, today.' },
      ],
      extensions: [],
    }, { subtitleCount: 5, targetLevel: '简单' })
    assert.equal(r.subtitlePrompts.length, 1)
  })

  it('扩展句 ≤5 且不足 5 条时给告警', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.equal(r.extensionPrompts.length, 2)
    assert.ok(r.warnings.includes('扩展句不足 5 条（2 条）'))
  })
})

describe('extractionVerdict', () => {
  it('没有字幕句 → 不合格（保留旧文件）', () => {
    const v = extractionVerdict(0, 5)
    assert.equal(v.ok, false)
    assert.ok(v.reason.includes('字幕句'))
  })
  it('扩展句少于下限 → 不合格', () => {
    const v = extractionVerdict(10, 2)
    assert.equal(v.ok, false)
    assert.ok(v.reason.includes('2'))
  })
  it('扩展句 3~4 条仍算合格（只告警，不丢整条视频）', () => {
    assert.equal(extractionVerdict(10, 3).ok, true)
    assert.equal(extractionVerdict(10, 4).ok, true)
  })
  it('字幕句至少 1 条 + 扩展句足额 → 合格', () => {
    assert.equal(extractionVerdict(1, 5).ok, true)
  })
  it('畸形入参不抛错', () => {
    assert.equal(extractionVerdict(null, null).ok, false)
    assert.equal(extractionVerdict(undefined, undefined).ok, false)
  })
})

describe('promptBadges', () => {
  it('扩展句 + 难度 → 两个标签，顺序固定', () => {
    assert.deepEqual(promptBadges({ source: 'ai_generated', level: '中等' }), [
      { kind: 'extension', text: '场景扩展' },
      { kind: 'level', text: '中等' },
    ])
  })
  it('字幕句只有难度', () => {
    assert.deepEqual(promptBadges({ source: 'subtitle', level: '简单' }), [{ kind: 'level', text: '简单' }])
  })
  it('旧 v1 文件（有 source 无 level）只显示场景扩展', () => {
    assert.deepEqual(promptBadges({ source: 'ai_generated' }), [{ kind: 'extension', text: '场景扩展' }])
  })
  it('兜底题目（level:null）不显示难度', () => {
    assert.deepEqual(promptBadges({ source: 'subtitle', level: null }), [])
  })
  it('非法 level 不显示、null 输入不抛错', () => {
    assert.deepEqual(promptBadges({ source: 'ai_generated', level: '超难' }), [{ kind: 'extension', text: '场景扩展' }])
    assert.deepEqual(promptBadges(null), [])
  })
})
