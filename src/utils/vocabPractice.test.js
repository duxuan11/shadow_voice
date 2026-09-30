import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRACTICE_TYPE_LABELS,
  shuffle,
  buildPracticeQueue,
  proficiencyFrom,
  proficiencyOf,
  summarizePracticeByType,
} from './vocabPractice.js'

const VOCAB = [
  { word: 'check in', content: 'check in', type: 'phrase', practice_count: 2, correct_count: 2 },
  { word: 'passport', content: 'Passport', type: 'word', practice_count: 4, correct_count: 1 },
  { word: 'it turns out that', content: 'It turns out that ...', type: 'core_phrase', practice_count: 0, correct_count: 0 },
]

test('PRACTICE_TYPE_LABELS：core_phrase 显示为句子', () => {
  assert.equal(PRACTICE_TYPE_LABELS.core_phrase, '句子')
  assert.equal(PRACTICE_TYPE_LABELS.word, '单词')
  assert.equal(PRACTICE_TYPE_LABELS.phrase, '短语')
})

test('shuffle：不改动原数组且保留全部元素', () => {
  const input = [1, 2, 3, 4, 5]
  const out = shuffle(input)
  assert.deepEqual(input, [1, 2, 3, 4, 5])
  assert.deepEqual([...out].sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

test('buildPracticeQueue：按类型筛选', () => {
  assert.equal(buildPracticeQueue(VOCAB, { type: 'all' }).length, 3)
  assert.equal(buildPracticeQueue(VOCAB, { type: 'word' }).length, 1)
  assert.equal(buildPracticeQueue(VOCAB, { type: 'core_phrase' })[0].word, 'it turns out that')
})

test('buildPracticeQueue：?word= 单条成轮（忽略大小写与标点）', () => {
  const q = buildPracticeQueue(VOCAB, { word: 'Check In!' })
  assert.equal(q.length, 1)
  assert.equal(q[0].word, 'check in')
})

test('buildPracticeQueue：未收录 → 空队列', () => {
  assert.deepEqual(buildPracticeQueue(VOCAB, { word: 'nope' }), [])
})

test('proficiencyFrom：未练与等级阈值', () => {
  assert.deepEqual(proficiencyFrom(0, 0), { percent: 0, level: 'new', label: '未练' })
  assert.equal(proficiencyFrom(1, 3).label, '生疏')   // 33
  assert.equal(proficiencyFrom(3, 4).label, '一般')   // 75
  assert.equal(proficiencyFrom(9, 10).label, '熟练')  // 90
})

test('proficiencyFrom：边界 60 / 85', () => {
  assert.equal(proficiencyFrom(3, 5).label, '一般')    // 60
  assert.equal(proficiencyFrom(84, 100).label, '一般') // 84
  assert.equal(proficiencyFrom(85, 100).label, '熟练') // 85
})

test('proficiencyOf：读取条目统计', () => {
  assert.equal(proficiencyOf(VOCAB[1]).label, '生疏') // 1/4 = 25
  assert.equal(proficiencyOf(VOCAB[2]).label, '未练')
})

test('summarizePracticeByType：按类型汇总', () => {
  const s = summarizePracticeByType(VOCAB)
  assert.equal(s.word.total, 1)
  assert.equal(s.word.practiceCount, 4)
  assert.equal(s.word.correctCount, 1)
  assert.equal(s.word.proficiency.percent, 25)
  assert.equal(s.phrase.practiceCount, 2)
  assert.equal(s.core_phrase.proficiency.level, 'new')
})
