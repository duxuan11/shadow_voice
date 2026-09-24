import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { copyDataFiles } from './copy-data.mjs'

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-data-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('copyDataFiles', () => {
  it('复制存在的索引 JSON 到目标目录并返回文件名', () => {
    const src = path.join(tmp, 'data'); fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'consolidated.json'), '[]')
    fs.writeFileSync(path.join(src, 'meta.json'), '{}')
    const out = path.join(tmp, 'dist', 'data')
    const copied = copyDataFiles(src, out)
    assert.deepEqual(copied, ['consolidated.json', 'meta.json'])
    assert.equal(fs.readFileSync(path.join(out, 'consolidated.json'), 'utf-8'), '[]')
    assert.equal(fs.readFileSync(path.join(out, 'meta.json'), 'utf-8'), '{}')
  })

  it('源文件缺失时跳过，仍创建目标目录', () => {
    const src = path.join(tmp, 'empty'); fs.mkdirSync(src)
    const out = path.join(tmp, 'dist', 'data')
    const copied = copyDataFiles(src, out)
    assert.deepEqual(copied, [])
    assert.ok(fs.existsSync(out))
  })

  it('只存在部分文件时只复制存在的', () => {
    const src = path.join(tmp, 'partial'); fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'meta.json'), '{"a":1}')
    const out = path.join(tmp, 'dist', 'data')
    assert.deepEqual(copyDataFiles(src, out), ['meta.json'])
    assert.ok(fs.existsSync(path.join(out, 'meta.json')))
    assert.ok(!fs.existsSync(path.join(out, 'consolidated.json')))
  })
})
