const test = require('node:test')
const assert = require('node:assert/strict')

// 回归测试：CreateToken 响应的两种形状解析（2026-08-24 用户实测 500 根因）。
// getToken() 里的 RPCClient 不走 global.fetch，无法在单测里 stub，因此把
// 响应解析抽成纯函数 parseTokenResponse 直接测两种形状。
const aliyun = require('./aliyun.cjs')

test('parseTokenResponse 新形状：Token 为对象 → 取 Id + 内部 ExpireTime', () => {
  const { token, expireAt } = aliyun.parseTokenResponse({
    ErrMsg: '',
    Token: { UserId: 'u1', Id: 'abcdef1234567890abcdef1234567890', ExpireTime: 1787705774 },
  })
  assert.equal(token, 'abcdef1234567890abcdef1234567890')
  assert.equal(expireAt, 1787705774 * 1000)
})

test('parseTokenResponse 旧形状：Token 为字符串 + 顶层 ExpireTime', () => {
  const { token, expireAt } = aliyun.parseTokenResponse({ Token: 'legacy-token', ExpireTime: 1787705774 })
  assert.equal(token, 'legacy-token')
  assert.equal(expireAt, 1787705774 * 1000)
})

test('parseTokenResponse 畸形/空 → token 空，expireAt 回退 24h', () => {
  assert.ok(!aliyun.parseTokenResponse(null).token)
  assert.ok(!aliyun.parseTokenResponse({ ErrMsg: 'bad' }).token)
  assert.equal(aliyun.parseTokenResponse({ Token: { Id: '' } }).token, '')
  const { expireAt } = aliyun.parseTokenResponse({ Token: { Id: 'x' } })
  assert.ok(expireAt > Date.now() + 23 * 3600 * 1000)
})
