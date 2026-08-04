import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEngineSdkUrl, analyzeEngineSdkBody } from './engineSdk.js'

test('buildEngineSdkUrl 拼接版本号查询参数', () => {
  assert.equal(buildEngineSdkUrl(3), '/sdk/engine.js?v=3')
})

test('analyzeEngineSdkBody: 真实 SDK 内容判定可用', () => {
  const body = '!function(e){var t={};/* ... */}window.EngineEvaluat=v'
  const r = analyzeEngineSdkBody(body)
  assert.equal(r.ok, true)
  assert.equal(r.code, 'OK')
})

test('analyzeEngineSdkBody: index.html 兜底内容判定 NOT_SDK（生产 dist 过期场景）', () => {
  const body = '<!DOCTYPE html><html><head><title>x</title></head><body><div id="root"></div></body></html>'
  const r = analyzeEngineSdkBody(body)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_SDK')
  assert.match(r.message, /index\.html/)
})

test('analyzeEngineSdkBody: 合法 JS 但缺少全局定义判定 NOT_SDK', () => {
  const r = analyzeEngineSdkBody('var foo = 1; console.log("hi")')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_SDK')
})

test('analyzeEngineSdkBody: 空白/空内容判定 EMPTY', () => {
  const r = analyzeEngineSdkBody('   \n\t ')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'EMPTY')
})

test('analyzeEngineSdkBody: 非字符串输入按空处理', () => {
  assert.equal(analyzeEngineSdkBody(undefined).ok, false)
})
