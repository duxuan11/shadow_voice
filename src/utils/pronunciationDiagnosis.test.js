import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnose } from './pronunciationDiagnosis.js'

const w = (char, score, start, end, phones, extra = {}) => ({
  char, score, start, end,
  phones: phones.map(([c, s]) => ({ char: c, score: s, pherr: 0, ph2alpha: c })),
  dpType: 0, isPause: false, fakePron: false, ...extra,
})
const parsed = (words) => ({ overall: 96, words })

// 真实连读版（2026-11-26 spike `s1-us`）：get 510-720 (t:95) → out 720-870 (aw:99)，间隙 0ms
const linked = parsed([
  w('get', 97, 510, 720, [['g', 98], ['eh', 99], ['t', 95]]),
  w('out', 100, 720, 870, [['aw', 99], ['t', 100]]),
])
// 断开版（spike `gapB-400`）：get 510-960 (t:85) → out 1440-1680，间隙 480ms
const split = parsed([
  w('get', 94, 510, 960, [['g', 100], ['eh', 96], ['t', 85]]),
  w('out', 99, 1440, 1680, [['aw', 99], ['t', 99]]),
])

test('自然连读（间隙 0ms）不报问题', () => {
  const r = diagnose(linked, { refText: 'get out' })
  assert.equal(r.items.length, 0)
  assert.equal(r.top, null)
  assert.equal(r.stats.boundaries, 1)
})

test('断开 480ms → link-missing（suggestion）', () => {
  const r = diagnose(split, { refText: 'get out' })
  assert.equal(r.items.length, 1)
  const it = r.items[0]
  assert.equal(it.id, 'link-missing')
  assert.equal(it.level, 'suggestion')
  assert.equal(it.wordIndex, 0)
  assert.deepEqual(it.pair, [0, 1])
  assert.equal(it.text, 'get out')
  assert.equal(it.evidence.gapMs, 480)
  assert.equal(it.evidence.tailScore, 85)
  assert.match(it.message, /连读/)
  assert.match(it.message, /480/)
  assert.equal(r.top.id, 'link-missing')
})

test('失爆：爆破音 + 辅音开头 + 间隙小 + 70 分 → hint 且文案说明不是错', () => {
  const p = parsed([
    w('get', 90, 0, 200, [['g', 95], ['eh', 90], ['t', 70]]),
    w('to', 90, 210, 330, [['t', 95], ['ax', 92]]),
  ])
  const r = diagnose(p, { refText: 'get to' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 'stop-elision')
  assert.equal(r.items[0].level, 'hint')
  assert.match(r.items[0].message, /不是错/)
})

test('失爆上下文（爆破音+辅音头+紧挨）内极低分只报警告，不报错误', () => {
  // 实测：native 朗读 "eat yet" 的 /t/ 只有 49~76 分（/t/+/j/ 合流），
  // 听感上无法区分“正常失爆”与“真漏读”，因此在失爆上下文里不给红色错误。
  const p = parsed([
    w('asked', 70, 0, 300, [['ae', 90], ['s', 90], ['k', 88], ['t', 45]]),
    w('to', 90, 310, 400, [['t', 92], ['ax', 90]]),
  ])
  const r = diagnose(p, { refText: 'asked to' })
  assert.equal(r.items[0].id, 'stop-elision')
  assert.equal(r.items[0].level, 'hint')
})

test('非失爆上下文（辅音尾不接辅音）低分 → coda-loss（error）', () => {
  const p = parsed([
    w('book', 70, 0, 300, [['b', 90], ['u', 90], ['k', 45]]),
    w('out', 90, 320, 500, [['aw', 92], ['t', 90]]),
  ])
  const r = diagnose(p, { refText: 'book out' })
  assert.equal(r.items[0].id, 'coda-loss')
  assert.equal(r.items[0].level, 'error')
})

test('Review Focus 4：is_pause 的词对仍要参与判定（停顿正是连读失败的证据）', () => {
  // 实测 gapB-800：人为断开 870ms 时引擎给 get 打了 is_pause:1，
  // 若因此排除该词对，最强信号会被吞掉。
  const p = parsed([
    w('get', 89, 510, 960, [['g', 100], ['eh', 91], ['t', 77]], { isPause: true }),
    w('out', 99, 1830, 2070, [['aw', 99], ['t', 100]]),
  ])
  const r = diagnose(p, { refText: 'get out' })
  assert.equal(r.items[0].id, 'link-missing')
  assert.equal(r.items[0].evidence.gapMs, 870)
})

test('意群边界（逗号后）不报 link-missing', () => {
  const r = diagnose(split, { refText: 'get, out' })
  assert.equal(r.items.length, 0)
})

test('dp_type!=0 / fakePron 的词对排除（is_pause 不排除）', () => {
  const variants = [
    parsed([w('get', 94, 510, 960, [['t', 85]], { dpType: 1 }), w('out', 99, 1440, 1680, [['aw', 99]])]),
    parsed([w('get', 94, 510, 960, [['t', 85]]), w('out', 99, 1440, 1680, [['aw', 99]], { fakePron: true })]),
  ]
  for (const v of variants) assert.equal(diagnose(v, { refText: 'get out' }).items.length, 0)
})

test('Review Focus 1/3：单词句、start/end 为 null、phones 为空都不崩', () => {
  assert.deepEqual(diagnose(parsed([w('get', 90, 0, 100, [['t', 80]])]), { refText: 'get' }),
    { items: [], top: null, stats: { boundaries: 0, problematic: 0 } })
  assert.equal(diagnose(parsed([w('a', 90, null, null, [['t', 85]]), w('out', 99, 100, 200, [['aw', 99]])]), { refText: 'a out' }).items.length, 0)
  assert.equal(diagnose(parsed([w('a', 90, 0, 100, []), w('out', 99, 400, 500, [['aw', 99]])]), { refText: 'a out' }).items.length, 0)
  assert.equal(diagnose({}, { refText: '' }).items.length, 0)
})

test('Review Focus 2：未知音素符号不误判（不猜辅音/元音）', () => {
  const p = parsed([w('get', 94, 0, 300, [['zzz', 40]]), w('out', 99, 900, 1000, [['aw', 99]])])
  assert.equal(diagnose(p, { refText: 'get out' }).items.length, 0)
})

test('多问题排序：error 优先于 suggestion', () => {
  const p = parsed([
    w('get', 94, 0, 300, [['t', 85]]),
    w('out', 99, 800, 900, [['aw', 99]]),
    w('book', 70, 950, 1150, [['k', 40]]),
    w('up', 90, 1160, 1250, [['ah', 92]]),
  ])
  const r = diagnose(p, { refText: 'get out book up' })
  assert.equal(r.top.id, 'coda-loss')
  assert.equal(r.stats.problematic, r.items.length)
  assert.ok(r.stats.boundaries >= 2)
})
