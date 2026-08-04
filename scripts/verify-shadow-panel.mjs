#!/usr/bin/env node
// CDP 验证：跟读面板「播放原音」= 视频原声（非 TTS），且句末自动暂停
// 前置：
//   1) chromium --headless=new --remote-debugging-port=9222 已启动（加 --no-sandbox --autoplay-policy=no-user-gesture-required）
//   2) 应用已构建并运行在 http://localhost:3001（npm run build && node server/index.cjs）
// 用法：node scripts/verify-shadow-panel.mjs [desktop|mobile|all]
const BASE = 'http://127.0.0.1:9222'
const APP = 'http://localhost:3001'
const PAGE = `${APP}/video/33650c75-6deb-4911-bea8-a9645e4a836b` // 出国旅行的日常

// 目标句（41s 处，字幕 index 17）
const EXPECTED_TEXT = 'now we don\'t say the 21 floor'
const SUB_START = 40.133
const SUB_END = 42.166

const mode = process.argv[2] || 'all'
const modes = mode === 'all' ? ['desktop', 'mobile'] : [mode]
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0

function check(name, cond, detail) {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
  if (!ok) failures++
}

async function newTab(url) {
  const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  return res.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id
          pending.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      close() { ws.close() }
    })
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
      }
    }
    ws.onerror = reject
  })
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
  return r.result.value
}

async function runMode(modeName) {
  console.log(`\n=== ${modeName.toUpperCase()} ===`)
  const isMobile = modeName === 'mobile'
  const tab = await newTab(APP + '/')
  const cdp = await connect(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await sleep(2500)
  await ev(cdp, `sessionStorage.setItem('shadow_voice_guest','true')`)
  if (isMobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  }
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(5000)

  // 1) 播放视频并 seek 到 41s，激活字幕 17，随后暂停停在句内
  await ev(cdp, `document.querySelector('video').play()`)
  await sleep(800)
  await ev(cdp, `document.querySelector('video').currentTime = 41`)
  await sleep(1200)
  await ev(cdp, `document.querySelector('video').pause()`)
  await sleep(600)

  // 2) 切到「跟读」面板
  if (isMobile) {
    await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('跟读')); b && b.click(); return !!b })()`)
  } else {
    await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('跟读')); b && b.click(); return !!b })()`)
  }
  await sleep(1200)

  // 面板头部计数器应显示 18 / 35（字幕 17）——仅移动端 nav header 有该计数器
  if (isMobile) {
    const counter = await ev(cdp, `document.body.textContent.includes('18 / 35')`)
    check(`[${modeName}] 当前句=字幕17（计数器 18 / 35）`, counter === true)
  }

  // 3) 面板当前句应为目标句
  const panelText = await ev(cdp, `document.body.textContent.includes(${JSON.stringify(EXPECTED_TEXT)})`)
  check(`[${modeName}] 跟读面板显示目标句`, panelText === true, EXPECTED_TEXT)

  // 4) 拦截 speechSynthesis.speak，验证不触发 TTS
  await ev(cdp, `window.__ttsCalls = 0; if (window.speechSynthesis) { const o = window.speechSynthesis.speak.bind(window.speechSynthesis); window.speechSynthesis.speak = u => { window.__ttsCalls++; return o(u) } }`)

  // 5) 点击「播放原音」
  const clicked = await ev(cdp, `(() => { const b = document.querySelector('button[title="播放原音"], button[title^="播放原音"]'); if (!b) return false; b.click(); return true })()`)
  check(`[${modeName}] 找到并点击 播放原音 按钮`, clicked === true)
  await sleep(900)

  // 6) 视频应 seek 到句首并播放（原声来自视频，而非 TTS）
  const st = await ev(cdp, `(() => { const v = document.querySelector('video'); return { t: v.currentTime, paused: v.paused, tts: window.__ttsCalls } })()`)
  check(`[${modeName}] 视频已 seek 到句首 ${SUB_START}`, st.t !== undefined && st.t >= SUB_START - 0.6 && st.t <= SUB_END, `t=${st.t?.toFixed?.(2)}`)
  check(`[${modeName}] 视频处于播放中（原声）`, st.paused === false, `paused=${st.paused}`)
  check(`[${modeName}] 未触发 TTS (speechSynthesis.speak==0)`, st.tts === 0, `tts=${st.tts}`)

  // 7) 句末应自动暂停（endTime ${SUB_END}）——轮询等待，兼容无头环境慢速播放
  let st2 = { paused: false, t: 0 }
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    st2 = await ev(cdp, `(() => { const v = document.querySelector('video'); return { t: v.currentTime, paused: v.paused } })()`)
    if (st2.paused === true) break
  }
  check(`[${modeName}] 句末自动暂停`, st2.paused === true, `t=${st2.t?.toFixed?.(2)} paused=${st2.paused}`)

  cdp.close()
  try { await fetch(`${BASE}/json/close/${tab.id}`) } catch { /* ignore */ }
}

;(async () => {
  for (const m of modes) await runMode(m)
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
