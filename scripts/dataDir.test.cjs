const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { resolveDataDir } = require('./dataDir.cjs')

describe('resolveDataDir', () => {
  const root = '/root'

  it('空值/非字符串默认 <root>/data', () => {
    assert.equal(resolveDataDir('', root), path.join(root, 'data'))
    assert.equal(resolveDataDir(undefined, root), path.join(root, 'data'))
    assert.equal(resolveDataDir(null, root), path.join(root, 'data'))
    assert.equal(resolveDataDir('   ', root), path.join(root, 'data'))
    assert.equal(resolveDataDir(123, root), path.join(root, 'data'))
  })

  it('相对路径相对 root 解析（去掉首尾空白）', () => {
    assert.equal(resolveDataDir('data', root), path.join(root, 'data'))
    assert.equal(resolveDataDir('./my-data', root), path.join(root, 'my-data'))
    assert.equal(resolveDataDir('  ./x  ', root), path.join(root, 'x'))
  })

  it('绝对路径原样返回', () => {
    assert.equal(resolveDataDir('/mnt/videos', root), path.normalize('/mnt/videos'))
  })
})
