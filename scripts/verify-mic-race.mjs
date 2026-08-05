#!/usr/bin/env node
// 验证：跟读评测「手机端点击麦克风报 createMediaStreamSource 类型错误」的竞态与修复。
//
// 背景（已从 public/sdk/engine.js 反混淆确认的调用契约）：
//   1. 引擎初始化时发起 navigator.mediaDevices.getUserMedia({audio:true})（异步）。
//      stream 仅在 getUserMedia 的 then 回调里赋值 e._audio.stream，随后才调 micAllowCallback。
//   2. engineFirstInitDone 在 getUserMedia 发起后、完成前就触发（只等动态服务地址网络往返）。
//   3. startRecord → 同步执行 createMediaStreamSource(e._audio.stream)。
//   => 移动端 getUserMedia 慢（权限弹窗/设备枚举，1~5s）> 地址请求往返时，
//      startRecord 先于 stream 就绪执行，createMediaStreamSource(null) 抛出
//      "parameter 1 is not of type 'MediaStream'"。
//
// 本脚本用同样的时序模拟两种流程：
//   A. 旧流程：engineFirstInitDone 后立即 startRecord  → 复现报错（FAIL）
//   B. 修复流程：startRecord 前 await micAllowCallback → 拿到 stream（PASS）
//
// 用法：node scripts/verify-mic-race.mjs
let failures = 0
function check(name, cond, detail) {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
  if (!ok) failures++
}

// ── 模拟浏览器环境（契约与 engine.js 一致）──
class MockMediaStream { constructor() { this.tracks = [] } }

const REAL_ERR_MSG = "Failed to execute 'createMediaStreamSource' on 'AudioContext': parameter 1 is not of type 'MediaStream'."

// 模拟 engine.js 的 AudioContext.createMediaStreamSource：非 MediaStream 时抛与真实 DOM 相同错误
function createMediaStreamSource(stream) {
  if (!(stream instanceof MockMediaStream)) {
    throw new TypeError(REAL_ERR_MSG)
  }
  return { stream }
}

function makeMockEngine({ getUserMediaDelay, addressRoundTrip, getUserMediaFails = false }) {
  // ── 引擎内部状态（对应 e._audio.stream）──
  let _audioStream = null
  const engine = {
    _audioStream: () => _audioStream,
    // init(e) 对应 engine.js 的 S(e)：发起 getUserMedia（异步）+ 触发 engineFirstInitDone
    init({ micAllowCallback, micForbidCallback, engineFirstInitDone }) {
      // getUserMedia 发起（fire-and-forget）：成功→先赋 stream 再 micAllowCallback；
      // 失败（权限拒绝）→ micForbidCallback（对应 engine.js 的 .catch 分支）
      setTimeout(() => {
        if (getUserMediaFails) {
          micForbidCallback(new Error('NotAllowedError'))
        } else {
          _audioStream = new MockMediaStream() // 对应 e._audio.stream = t
          micAllowCallback()                   // 先赋值 stream，再回调
        }
      }, getUserMediaDelay)
      // 动态服务地址网络往返（allowDynamicService=1 默认）→ engineFirstInitDone
      setTimeout(engineFirstInitDone, addressRoundTrip)
    },
    // startRecord 对应 engine.js 的 f(e)：同步执行 createMediaStreamSource
    startRecord() {
      return createMediaStreamSource(_audioStream)
    },
  }
  return engine
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── A. 旧流程：engineFirstInitDone 后立即 startRecord（复现线上报错）──
async function oldFlow() {
  const engine = makeMockEngine({ getUserMediaDelay: 800, addressRoundTrip: 50 })
  let firstInitDoneAt = null
  let recordError = null
  let recordOk = false

  engine.init({
    micAllowCallback: () => {},
    micForbidCallback: () => {},
    engineFirstInitDone: () => { firstInitDoneAt = Date.now() },
  })

  // 旧代码 waitInit() 在 engineFirstInitDone 后立即返回，随后 startRecord
  await sleep(60) // 等 engineFirstInitDone（50ms）触发
  check('旧流程：engineFirstInitDone 先于 getUserMedia 完成触发（竞态前提）', firstInitDoneAt !== null)
  try {
    engine.startRecord()
    recordOk = true
  } catch (e) {
    recordError = e.message
  }
  check('旧流程：startRecord 时 stream 尚未就绪', !recordOk, recordError || '未报错')
  check('旧流程：报错与线上一致', recordError === REAL_ERR_MSG, recordError)
}

// ── B. 修复流程：await micAllowCallback（stream 就绪信号）后再 startRecord ──
async function fixedFlow() {
  const engine = makeMockEngine({ getUserMediaDelay: 800, addressRoundTrip: 50 })
  let resolveMic, rejectMic
  const micReady = new Promise((res, rej) => { resolveMic = res; rejectMic = rej })

  engine.init({
    micAllowCallback: () => resolveMic(),          // 对应修复后的 micAllowCallback
    micForbidCallback: () => rejectMic(new Error('MIC_FORBIDDEN')),
    engineFirstInitDone: () => {},
  })

  await micReady // 修复代码在 startRecord 前 await 此 promise
  const source = engine.startRecord()
  check('修复流程：startRecord 前等待 stream 就绪', source && source.stream instanceof MockMediaStream)
}

// ── C. 修复流程：权限被拒 → 拒绝 promise，startRecord 不会执行 ──
async function deniedFlow() {
  // getUserMedia 被拒（对应真实 engine 的 .catch → micForbidCallback）
  const engine = makeMockEngine({ getUserMediaDelay: 200, addressRoundTrip: 50, getUserMediaFails: true })
  let resolveMic, rejectMic
  const micReady = new Promise((res, rej) => { resolveMic = res; rejectMic = rej })
  let micForbidCalled = false

  engine.init({
    micAllowCallback: () => resolveMic(),
    micForbidCallback: () => { micForbidCalled = true; rejectMic(new Error('MIC_FORBIDDEN')) },
    engineFirstInitDone: () => {},
  })

  let rejected = false
  try { await micReady } catch { rejected = true }
  check('修复流程：权限被拒时 micReady 被拒绝（startRecord 被阻断）', rejected)
  check('修复流程：micForbidCallback 被调用', micForbidCalled)
}

await oldFlow()
console.log()
await fixedFlow()
console.log()
await deniedFlow()

console.log()
if (failures > 0) {
  console.log(`✗ ${failures} 项失败`)
  process.exit(1)
}
console.log('✓ 全部通过：竞态复现、修复生效、拒绝路径阻断')
