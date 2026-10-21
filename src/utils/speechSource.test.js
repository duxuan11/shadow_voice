import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSpeechSource } from './speechSource.js'

test('服务端 ASR 已配置 → aliyun', () => {
  assert.equal(selectSpeechSource({ configured: true, hasWebSpeech: true }), 'aliyun')
  assert.equal(selectSpeechSource({ configured: true, hasWebSpeech: false }), 'aliyun')
})

test('未配置但有浏览器识别 → web', () => {
  assert.equal(selectSpeechSource({ configured: false, hasWebSpeech: true }), 'web')
})

test('都没有 → none，且容忍畸形入参', () => {
  assert.equal(selectSpeechSource({ configured: false, hasWebSpeech: false }), 'none')
  assert.equal(selectSpeechSource(null), 'none')
  assert.equal(selectSpeechSource(undefined), 'none')
})
