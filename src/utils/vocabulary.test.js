import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeVocabKey,
  buildVocabPayload,
  findVocabEntry,
  vocabKeys,
  filterVocabByType,
  countVocabByType,
  VOCAB_TYPE_LABELS,
} from './vocabulary.js'

test('normalizeVocabKey：小写、去标点、合并空白，保留撇号', () => {
  assert.equal(normalizeVocabKey('  Check   In! '), 'check in')
  assert.equal(normalizeVocabKey("Don't"), "don't")
  assert.equal(normalizeVocabKey('It turns out that...'), 'it turns out that')
  assert.equal(normalizeVocabKey(''), '')
  assert.equal(normalizeVocabKey(null), '')
})

test('buildVocabPayload：单词卡', () => {
  const p = buildVocabPayload({
    cardType: 'words',
    item: { word: 'Check', meaning: '检查', count: 3, times: [1, 2, 3] },
    videoId: 'v1',
    videoTitle: 'Hotel Check-in',
    phonetic: '/tʃɛk/',
  })
  assert.deepEqual(p, {
    content: 'Check',
    word: 'check',
    translation: '检查',
    type: 'word',
    phonetic: '/tʃɛk/',
    videoId: 'v1',
    videoTitle: 'Hotel Check-in',
  })
})

test('buildVocabPayload：短语卡', () => {
  const p = buildVocabPayload({
    cardType: 'phrases',
    item: { text: 'check in', meaning: '办理入住' },
    videoId: 'v1',
    videoTitle: 'Hotel Check-in',
  })
  assert.equal(p.content, 'check in')
  assert.equal(p.word, 'check in')
  assert.equal(p.translation, '办理入住')
  assert.equal(p.type, 'phrase')
  assert.equal(p.phonetic, '')
})

test('buildVocabPayload：核心短语卡（地道表达）', () => {
  const p = buildVocabPayload({
    cardType: 'expressions',
    item: { textEn: 'It turns out that ...', textCn: '结果……', meaning: '转折用法' },
    videoId: 'v2',
    videoTitle: 'Business Travel',
  })
  assert.equal(p.content, 'It turns out that ...')
  assert.equal(p.type, 'core_phrase')
  assert.equal(p.translation, '转折用法')
})

test('buildVocabPayload：空内容返回 null', () => {
  assert.equal(buildVocabPayload({ cardType: 'words', item: { word: '   ' } }), null)
  assert.equal(buildVocabPayload({ cardType: 'words', item: null }), null)
})

test('findVocabEntry / vocabKeys：按规范化内容匹配', () => {
  const vocab = [
    { word: 'check in', content: 'Check In', type: 'phrase' },
    { word: 'experience', content: 'experience', type: 'word' },
  ]
  assert.equal(findVocabEntry(vocab, 'check in')?.content, 'Check In')
  assert.equal(findVocabEntry(vocab, 'nope'), null)
  assert.deepEqual([...vocabKeys(vocab)].sort(), ['check in', 'experience'])
})

test('filterVocabByType / countVocabByType', () => {
  const vocab = [
    { type: 'word' },
    { type: 'word' },
    { type: 'phrase' },
    { type: 'core_phrase' },
    { /* 旧数据无 type */ },
  ]
  assert.equal(filterVocabByType(vocab, 'all').length, 5)
  assert.equal(filterVocabByType(vocab, 'word').length, 3) // 无 type 视为 word
  assert.equal(filterVocabByType(vocab, 'phrase').length, 1)
  assert.equal(filterVocabByType(vocab, 'core_phrase').length, 1)
  assert.deepEqual(countVocabByType(vocab), { all: 5, word: 3, phrase: 1, core_phrase: 1 })
})

test('VOCAB_TYPE_LABELS：三种类型都有中文标签', () => {
  assert.equal(VOCAB_TYPE_LABELS.word, '单词')
  assert.equal(VOCAB_TYPE_LABELS.phrase, '短语')
  assert.equal(VOCAB_TYPE_LABELS.core_phrase, '核心短语')
})
