// 重采样回归测试：pcmRecorder 的 linearDecimate 必须做"抽取"（降采样），
// 而不是把每个采样复制 ratio 份。
// 背景（2026-08-25 实测）：旧实现 while(acc>=1){acc-=1;push} 在 48k 硬件下
// 把每个采样复制 3 份 → 1s 音频变 9s(16k) → 阿里云一句话识别判定无有效语音 → 422。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { linearDecimate } from './pcmRecorder.js'

describe('linearDecimate', () => {
  it('48k→16k：输出约 1/3 采样，内容来自每隔 ratio 的采样位置', () => {
    const input = new Float32Array(300).map((_, i) => i)
    const out = linearDecimate(input, 48000, 16000)
    assert.equal(out.length, 100) // 300/3，而不是 300*3
    assert.equal(out[0], 0)
    assert.equal(out[1], 3)
    assert.equal(out[50], 150)
    assert.equal(out[99], 297)
  })

  it('44.1k→16k：输出约 16/44.1 比例', () => {
    const input = new Float32Array(4410).map((_, i) => i)
    const out = linearDecimate(input, 44100, 16000)
    assert.ok(Math.abs(out.length - 1600) <= 2, `实际 ${out.length}`)
  })

  it('输入采样率 == 目标采样率：原样输出', () => {
    const input = new Float32Array(100).map((_, i) => i)
    const out = linearDecimate(input, 16000, 16000)
    assert.deepEqual(Array.from(out), Array.from(input))
  })

  it('时长校验：1s 48k 输入不得膨胀（旧 bug 会变 9s）', () => {
    const input = new Float32Array(48000).fill(0.5) // 1 秒
    const out = linearDecimate(input, 48000, 16000)
    const seconds = out.length / 16000
    assert.ok(Math.abs(seconds - 1) < 0.01, `实际 ${seconds.toFixed(3)}s`)
  })
})
