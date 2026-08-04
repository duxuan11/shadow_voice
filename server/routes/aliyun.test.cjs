const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSign } = require('./aliyun.cjs')

test('buildSign 与官方示例基准值一致', () => {
  const sign = buildSign({
    appid: 'a111',
    timestamp: '1603885321',
    userId: 'w9egtDf3PMAOaxZVGSlQUip12no6WCvu',
    clientIp: '111.111.XXX.XXX',
    secret: 'wHkC1SMmDLrVO86vcydG2ax4oPYuqiIh',
  })
  // 官方 Python 示例参数对应的 MD5（已独立验证）
  assert.equal(sign, '65d9845fdc085bc45828b5cc16806d98')
})

test('buildSign 对相同参数幂等', () => {
  const p = { appid: 'a1', timestamp: '123', userId: 'u1', clientIp: '1.2.3.4', secret: 's1' }
  assert.equal(buildSign(p), buildSign(p))
})
