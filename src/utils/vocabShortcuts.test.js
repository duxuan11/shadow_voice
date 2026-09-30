import test from 'node:test'
import assert from 'node:assert/strict'
import { SHORTCUT_GROUPS, resolveShortcut } from './vocabShortcuts.js'

const t = (over) => resolveShortcut({ phase: 'typing', ...over })
const r = (over) => resolveShortcut({ phase: 'review', ...over })

test('SHORTCUT_GROUPS：包含三个分组与键位数据', () => {
  assert.deepEqual(SHORTCUT_GROUPS.map(g => g.title), ['答题中', '对照中', '全局'])
  const labels = SHORTCUT_GROUPS.flatMap(g => g.items.map(i => i.label))
  assert.ok(labels.includes('提交'))
  assert.ok(labels.includes('再听一次'))
  assert.ok(labels.includes('上一题'))
})

test('答题中（输入框聚焦）：只处理不打字冲突的键', () => {
  assert.equal(t({ key: 'Enter', inputFocused: true }), 'submit')
  assert.equal(t({ key: 'Enter', shiftKey: true, inputFocused: true }), null)
  assert.equal(t({ key: 'Enter', ctrlKey: true, inputFocused: true }), null)
  assert.equal(t({ key: 'Tab', inputFocused: true }), 'reveal')
  assert.equal(t({ key: 'Tab', shiftKey: true, inputFocused: true }), null)
  assert.equal(t({ key: ' ', ctrlKey: true, inputFocused: true }), 'replay')
  assert.equal(t({ key: 'R', altKey: true, inputFocused: true }), 'replay')
  assert.equal(t({ key: 'h', ctrlKey: true, inputFocused: true }), null)
  assert.equal(t({ key: '?', inputFocused: true }), null)
  assert.equal(t({ key: '/', inputFocused: true }), null)
  assert.equal(t({ key: '1', inputFocused: true }), null)
  assert.equal(resolveShortcut({ key: 'Escape', phase: 'typing', inputFocused: true }), 'back')
})

test('答题中（未聚焦）：Enter 提交、Ctrl+Space/Alt+R 重听', () => {
  assert.equal(t({ key: 'Enter' }), 'submit')
  assert.equal(t({ key: 'Enter', shiftKey: true }), null)
  assert.equal(t({ key: ' ', ctrlKey: true }), 'replay')
  assert.equal(t({ key: 'r', altKey: true }), 'replay')
  assert.equal(t({ key: 'H', metaKey: true }), null)
  assert.equal(t({ key: 'Tab' }), 'reveal')
})

test('对照中：Enter/Space 下一题，数字 1-4，← 上一题', () => {
  assert.equal(r({ key: 'Enter' }), 'next')
  assert.equal(r({ key: ' ' }), 'next')
  assert.equal(r({ key: ' ', ctrlKey: true }), null)
  assert.equal(r({ key: '1' }), 'replay')
  assert.equal(r({ key: '3' }), 'retry')
  assert.equal(r({ key: '4' }), 'next')
  assert.equal(r({ key: 'ArrowLeft' }), 'prev')
})

test('对照中：修饰键不触发数字/方向键', () => {
  assert.equal(r({ key: '1', ctrlKey: true }), null)
  assert.equal(r({ key: '1', shiftKey: true }), null)
  assert.equal(r({ key: '1', metaKey: true }), null)
  assert.equal(r({ key: 'ArrowLeft', shiftKey: true }), null)
})

test('setup / finished：Enter 开始 / 再来一轮', () => {
  assert.equal(resolveShortcut({ key: 'Enter', phase: 'setup' }), 'start')
  assert.equal(resolveShortcut({ key: 'Enter', phase: 'finished' }), 'again')
  assert.equal(resolveShortcut({ key: 'x', phase: 'setup' }), null)
})

test('全局：?// 打开帮助（已打开则吞掉其他键），Esc 关面板或返回', () => {
  assert.equal(r({ key: '?' }), 'help')
  assert.equal(r({ key: '/' }), 'help')
  assert.equal(r({ key: '?', helpOpen: true }), null)
  assert.equal(r({ key: 'Enter', helpOpen: true }), null)
  assert.equal(r({ key: '1', helpOpen: true }), null)
  assert.equal(r({ key: 'Escape', helpOpen: true }), 'closeHelp')
  assert.equal(r({ key: 'Escape', helpOpen: false }), 'back')
  assert.equal(t({ key: 'Escape' }), 'back')
})
