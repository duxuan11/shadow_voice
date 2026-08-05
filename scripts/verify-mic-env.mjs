#!/usr/bin/env node
// 单测：micEnvironmentProblem / jssdkNotSupportMessage（浏览器麦克风环境判定）。
// 背景：手机 Chrome 在明文 HTTP（非 localhost）下 navigator.mediaDevices/getUserMedia 整个
// 不存在，阿里云 engine.js 的 checkSuport 检测失败并回调 JSSDKNotSupport，前端曾误报
// "当前浏览器不支持评测 SDK，请使用 Chrome / Edge / Firefox"。
// 本脚本验证：环境问题应给出可操作的 HTTPS 提示；只有真浏览器不支持时才提示换浏览器。
import { micEnvironmentProblem, jssdkNotSupportMessage } from '../src/utils/engineSdk.js'

let failures = 0
function check(name, cond, detail) {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
  if (!ok) failures++
}

// 1) 明文 HTTP（非 localhost）：isSecureContext=false → INSECURE_CONTEXT + HTTPS 提示
{
  const env = { window: { isSecureContext: false }, navigator: { mediaDevices: { getUserMedia: () => {} } } }
  const p = micEnvironmentProblem(env)
  check('明文 HTTP：检测为 INSECURE_CONTEXT', p?.code === 'INSECURE_CONTEXT')
  check('明文 HTTP：提示含 HTTPS 解决方案', typeof p?.message === 'string' && p.message.includes('HTTPS'))
  const msg = jssdkNotSupportMessage(env)
  check('jssdkNotSupportMessage 在明文 HTTP 下不再误报"请使用 Chrome"', !msg.includes('请使用 Chrome'))
  check('jssdkNotSupportMessage 在明文 HTTP 下给出 HTTPS 提示', msg.includes('HTTPS'))
}

// 2) HTTPS + 标准 getUserMedia → 无问题
{
  const env = { window: { isSecureContext: true }, navigator: { mediaDevices: { getUserMedia: () => {} } } }
  check('HTTPS + mediaDevices.getUserMedia：无问题', micEnvironmentProblem(env) === null)
}

// 3) HTTPS + 仅旧式 navigator.getUserMedia（legacy 浏览器）→ 无问题
{
  const env = { window: { isSecureContext: true }, navigator: { getUserMedia: () => {} } }
  check('HTTPS + 旧式 getUserMedia：无问题', micEnvironmentProblem(env) === null)
}

// 4) HTTPS 但真的无 getUserMedia → NO_MEDIA_DEVICES（此时才提示换浏览器）
{
  const env = { window: { isSecureContext: true }, navigator: {} }
  const p = micEnvironmentProblem(env)
  check('HTTPS 但无 getUserMedia：检测为 NO_MEDIA_DEVICES', p?.code === 'NO_MEDIA_DEVICES')
  check('NO_MEDIA_DEVICES 时才提示换浏览器', jssdkNotSupportMessage(env).includes('Chrome / Edge / Firefox'))
}

// 5) 非浏览器环境（node 单测自身）→ 不误判
check('非浏览器环境：不判定环境问题', micEnvironmentProblem({ window: null, navigator: {} }) === null)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
