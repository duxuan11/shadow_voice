const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DIFFICULTIES, DIFFICULTY_LABELS, MIN_LINES, MAX_LINES,
  normalizeDifficulty, difficultyOf,
  buildScriptPrompt, normalizeDialogueScript,
  buildLineReviewPrompt, normalizeLineReview,
} = require('./dialogue.cjs')

const line = (n, extra = {}) => ({
  speaker: 'user', cn: `第${n}句中文`, en: `This is sentence number ${n}`,
  alternatives: ['a'], keyPoints: ['k'], ...extra,
})

test('难度枚举与视频等级映射', () => {
  assert.deepEqual(DIFFICULTIES, ['easy', 'daily', 'advanced'])
  assert.equal(DIFFICULTY_LABELS.advanced, '进阶')
  assert.equal(normalizeDifficulty('daily'), 'daily')
  assert.equal(normalizeDifficulty('中等'), null)
  assert.equal(difficultyOf('初级'), 'easy')
  assert.equal(difficultyOf('中级'), 'daily')
  assert.equal(difficultyOf('高级'), 'advanced')
  assert.equal(difficultyOf(undefined), 'daily')
})

test('生成 prompt 带上字幕、难度与人物关系要求', () => {
  const p = buildScriptPrompt({
    videoTitle: '出国旅行的日常', description: '机场与酒店', videoLevel: '中级',
    difficulty: 'daily',
    segments: [{ textEn: "we've just checked in", textCn: '我们刚办好入住' }],
    scene: { scene: 'Hotel Check-in', userRole: '客人', aiRole: '前台接待' },
  })
  assert.ok(p.user.includes('出国旅行的日常'))
  assert.ok(p.user.includes('我们刚办好入住'))
  assert.ok(p.user.includes('日常'))
  assert.ok(p.user.includes('前台接待'))
  assert.ok(p.system.includes('8'))
  assert.ok(p.system.includes('20'))
})

test('无字幕时 prompt 禁止编造视频内容并声明信息不足', () => {
  const p = buildScriptPrompt({ videoTitle: 'X', description: '', videoLevel: null, difficulty: 'easy', segments: [], scene: null })
  assert.ok(p.user.includes('没有字幕'))
  assert.ok(p.user.includes('不要编造'))
})

test('normalizeDialogueScript 去重、编号、截断到 20 并标记来源', () => {
  const raw = { title: '酒店入住', scene: 'Hotel', lines: Array.from({ length: 25 }, (_, i) => line(i + 1)) }
  const r = normalizeDialogueScript(raw, { difficulty: 'daily', hasSubtitles: true })
  assert.equal(r.ok, true)
  assert.equal(r.script.lines.length, MAX_LINES)
  assert.equal(r.script.lines[0].index, 0)
  assert.equal(r.script.lines[MAX_LINES - 1].index, MAX_LINES - 1)
  assert.equal(r.script.source, 'subtitle')
  assert.equal(r.script.difficulty, 'daily')
  assert.equal(new Set(r.script.lines.map(l => l.cn)).size, MAX_LINES)
})

test('normalizeDialogueScript 丢弃非法句，不足 5 句判不合格', () => {
  const bad = { lines: [{ cn: '只有中文' }, { cn: '', en: 'x y' }, line(1), line(2), line(3), line(4)] }
  assert.equal(normalizeDialogueScript(bad, { difficulty: 'easy', hasSubtitles: false }).ok, false)
  const ok = normalizeDialogueScript({ lines: Array.from({ length: MIN_LINES }, (_, i) => line(i + 1)) },
    { difficulty: 'easy', hasSubtitles: false })
  assert.equal(ok.ok, true)
  assert.equal(ok.script.source, 'video-info')
  assert.equal(ok.script.lines[0].speaker, 'user')
})

test('normalizeDialogueScript 对畸形输入不抛错', () => {
  for (const v of [null, undefined, 'x', 42, { lines: 'nope' }]) {
    const r = normalizeDialogueScript(v, { difficulty: 'daily', hasSubtitles: true })
    assert.equal(r.ok, false)
    assert.ok(r.reason.length > 0)
  }
})

test('单句评分 prompt 带上下文、可接受表达与重试次数', () => {
  const p = buildLineReviewPrompt({
    line: { cn: '我刚办好入住。', en: "I've just checked in.", alternatives: ['I just checked in.'], keyPoints: ['现在完成时'] },
    contextLines: [{ speakerCn: '前台', cn: '您好，请问有预订吗？' }],
    difficulty: 'daily', userText: 'I check in just now', attempt: 2,
  })
  assert.ok(p.user.includes('我刚办好入住。'))
  assert.ok(p.user.includes("I've just checked in."))
  assert.ok(p.user.includes('I just checked in.'))
  assert.ok(p.user.includes('您好，请问有预订吗？'))
  assert.ok(p.user.includes('I check in just now'))
  assert.ok(p.user.includes('2'))
  assert.ok(p.system.includes('不是唯一'))
  assert.ok(p.system.includes('verdict'))
})

test('normalizeDialogueScript：重复句只保留一次（不会重复练同一句）', () => {
  const raw = { lines: [line(1), line(1), line(2), line(3), line(4), line(5), line(6)] }
  const r = normalizeDialogueScript(raw, { difficulty: 'easy', hasSubtitles: true })
  assert.equal(r.ok, true)
  assert.equal(r.script.lines.length, 6)
  assert.equal(new Set(r.script.lines.map(l => l.cn)).size, 6)
})

test('normalizeLineReview：verdict 大小写与空格容错', () => {
  const r = normalizeLineReview({ verdict: ' Correct ', issues: [] }, { attempt: 1 })
  assert.equal(r.verdict, 'correct')
  assert.equal(r.answerHidden, false)
})

test('normalizeLineReview：verdict 归一 + 分数钳制', () => {
  assert.equal(normalizeLineReview({ verdict: 'correct', score: 92 }, { attempt: 1 }).verdict, 'correct')
  assert.equal(normalizeLineReview({ score: 85 }, { attempt: 1 }).verdict, 'correct')
  assert.equal(normalizeLineReview({ score: 70 }, { attempt: 1 }).verdict, 'minor')
  assert.equal(normalizeLineReview({ score: 40 }, { attempt: 1 }).verdict, 'wrong')
  assert.equal(normalizeLineReview({ score: 999, verdict: 'correct' }, { attempt: 1 }).score, 100)
  assert.equal(normalizeLineReview({}, { attempt: 1 }).score, null)
})

test('normalizeLineReview：wrong 且首次作答 → 隐藏英文答案并给中文提示', () => {
  const r = normalizeLineReview({
    verdict: 'wrong', score: 45, hint: '注意时态', better: 'I have just checked in.',
    issues: [{ type: 'grammar', location: 'check in', problem: '时态', suggestion: '用完成时', better: 'checked in' }],
    praise: '',
  }, { attempt: 1 })
  assert.equal(r.answerHidden, true)
  assert.equal(r.better, '')
  assert.equal(r.issues[0].better, '')
  assert.equal(r.issues[0].problem, '时态')
  assert.equal(r.hint, '注意时态')
})

test('normalizeLineReview：第二次或非 wrong → 不隐藏答案', () => {
  const wrong2 = normalizeLineReview({ verdict: 'wrong', better: 'B', hint: 'h' }, { attempt: 2 })
  assert.equal(wrong2.answerHidden, false)
  assert.equal(wrong2.better, 'B')
  const minor = normalizeLineReview({ verdict: 'minor', score: 72, better: 'B2' }, { attempt: 1 })
  assert.equal(minor.answerHidden, false)
  assert.equal(minor.better, 'B2')
})
