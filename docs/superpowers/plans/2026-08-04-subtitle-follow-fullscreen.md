# 字幕跟随与全屏横屏修复 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复视频播放页字幕"居中"导致整页被拖动的问题（改为温和跟随、置顶对齐、只滚字幕容器），并让手机端全屏能横屏（iOS 原生播放器 / 安卓横屏锁定）。

**Architecture:** 全部改动集中在 `src/pages/VideoDetail.jsx` 的 4 处：两个字幕自动滚动 useEffect（改用 `getBoundingClientRect` + 容器内 `scrollTo`，弃用 `scrollIntoView`）、`activeSubIndex` 更新逻辑（间隙保留上一条）、移动端外层容器 `h-screen`→`h-dvh`、`toggleFullscreen` 重写（iOS/安卓/桌面分平台处理）。新增 `scripts/verify-video-page.mjs` 作为 CDP 自动化回归验证脚本。

**Tech Stack:** React 19 + Vite 8 + Tailwind v4（`h-dvh` 内置），Node 22 全局 WebSocket（脚本用），无测试框架——用无头 Chromium CDP 脚本做验证。

## Global Constraints

- 只修改 `src/pages/VideoDetail.jsx`，新增 `scripts/verify-video-page.mjs`，不动其他文件。
- 跟随语义 = 用户批准的 B 方案（温和跟随）：当前句完全可见→不滚动；滚出可视区→滚动到字幕区顶部（留 8px）。
- 移动端底部固定操作栏遮挡字幕区底部，跟随时保留 80px 余量。
- 桌面端跟随不留底部余量（面板底部无遮挡）。
- 全屏：iOS 走 `video.webkitEnterFullscreen()`；安卓走 `requestFullscreen` + `screen.orientation.lock('landscape')`；老版 Safari 桌面用 `webkitRequestFullscreen` 降级；全屏请求被拒（如非 HTTPS）时不得把 `isFullscreen` 置 true。
- 视频全屏时 `object-cover` → `object-contain`（防裁切）。
- 字幕间隙（无字幕覆盖的时间段）保留上一条 `activeSubIndex`，不置 -1。
- ⚠️ `src/pages/VideoDetail.jsx` 当前含未提交的在途改动（进度上报/续播等，非本计划范围）。本计划提交该文件时会一并纳入——完成时向用户说明。
- 提交粒度：每个任务独立 commit；`dist/` 已被 .gitignore 排除，不提交构建产物。

---

### Task 1: 验证脚本 + 基线红灯

**Files:**
- Create: `scripts/verify-video-page.mjs`

**Interfaces:**
- Produces: `node scripts/verify-video-page.mjs [desktop|mobile|all]` — 退出码 0=全部通过，1=有失败；逐项打印 `PASS/FAIL`。

- [ ] **Step 1: 创建验证脚本**（CDP 驱动无头 Chromium，断言本计划全部验收点）

```js
#!/usr/bin/env node
// CDP 验证：shadow_voice 视频页 字幕跟随 / 全屏失败路径 行为
// 前置：
//   1) chromium --headless=new --remote-debugging-port=9222 已启动（加 --no-sandbox --autoplay-policy=no-user-gesture-required）
//   2) 应用已构建并运行在 http://localhost:3001（npm run build && node server/index.cjs）
// 用法：node scripts/verify-video-page.mjs [desktop|mobile|all]
const BASE = 'http://127.0.0.1:9222'
const APP = 'http://localhost:3001'
const PAGE = `${APP}/video/33650c75-6deb-4911-bea8-a9645e4a836b` // 出国旅行的日常

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
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }
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

  const cardSel = isMobile ? '[data-mobile-sub-index]' : '[id^="sub-item-"]'
  const activeCls = isMobile ? 'bg-gradient-to-br' : 'border-l-indigo-600'
  const snapExpr = `(() => {
    const cards = [...document.querySelectorAll('${cardSel}')]
    const activeIdx = cards.findIndex(c => c.className.includes('${activeCls}'))
    const scroller = cards[0]?.parentElement
    const cRect = scroller?.getBoundingClientRect()
    const eRect = activeIdx >= 0 ? cards[activeIdx].getBoundingClientRect() : null
    return {
      cardCount: cards.length,
      activeIdx,
      winScrollY: Math.round(window.scrollY),
      docScrollH: document.documentElement.scrollHeight,
      docClientH: document.documentElement.clientHeight,
      scrollerScrollTop: Math.round(scroller?.scrollTop ?? -1),
      topGap: eRect && cRect ? Math.round(eRect.top - cRect.top) : null,
      videoContain: document.querySelector('video')?.className.includes('object-contain') ?? false
    }
  })()`

  // 1) 页面加载
  let s = await ev(cdp, snapExpr)
  check(`[${modeName}] 字幕渲染 35 条`, s.cardCount === 35, `count=${s.cardCount}`)
  if (isMobile) {
    check(`[${modeName}] 文档无溢出 docScrollH==docClientH`, s.docScrollH === s.docClientH, `${s.docScrollH} vs ${s.docClientH}`)
  }
  check(`[${modeName}] 初始 window.scrollY==0`, s.winScrollY === 0, `y=${s.winScrollY}`)

  // 2) seek 41s（字幕17 内）→ 温和跟随：整页不动、容器滚动、当前句置顶
  await ev(cdp, `(() => { const v = document.querySelector('video'); if (v) v.currentTime = 41 })()`)
  await sleep(2400)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 整页未被拖动 winScrollY==0`, s.winScrollY === 0, `y=${s.winScrollY}`)
  check(`[${modeName}] 字幕容器已滚动`, s.scrollerScrollTop > 1000, `top=${s.scrollerScrollTop}`)
  check(`[${modeName}] 当前字幕置顶 topGap∈[0,20]`, s.topGap !== null && s.topGap >= 0 && s.topGap <= 20, `gap=${s.topGap}`)
  check(`[${modeName}] 当前字幕=17`, s.activeIdx === 17, `idx=${s.activeIdx}`)

  // 3) 间隙保留：38s→16，40.0s（间隙）→仍16
  await ev(cdp, `(() => { const v = document.querySelector('video'); if (v) v.currentTime = 38 })()`)
  await sleep(1500)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 38s 激活字幕=16`, s.activeIdx === 16, `idx=${s.activeIdx}`)
  await ev(cdp, `(() => { const v = document.querySelector('video'); if (v) v.currentTime = 40 })()`)
  await sleep(1500)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 间隙 40.0s 保留上一条=16`, s.activeIdx === 16, `idx=${s.activeIdx}`)

  // 4) 全屏失败路径（无头环境 requestFullscreen 必失败）→ isFullscreen 不置真
  await ev(cdp, `(() => { const b = document.querySelector('button[title="全屏"]'); if (b) b.click() })()`)
  await sleep(800)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 全屏失败后视频仍 object-cover`, s.videoContain === false)

  cdp.close()
}

;(async () => {
  for (const m of modes) await runMode(m)
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
```

- [ ] **Step 2: 启动依赖**（验证环境）

```bash
# 构建并重启应用（dist 是服务端唯一前端来源）
cd /home/duxuan/duxuan/code/english/shadow_voice && npm run build
pkill -f "node server/index.cjs"; setsid node server/index.cjs > /tmp/sv-server.log 2>&1 < /dev/null &
sleep 2; curl -s http://localhost:3001/api/health
# 无头 Chromium（CDP）
pkill -f "remote-debugging-port=9222"
setsid /snap/bin/chromium --headless=new --remote-debugging-port=9222 --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required --window-size=1440,900 about:blank > /tmp/sv-chromium.log 2>&1 < /dev/null &
sleep 5; curl -s http://127.0.0.1:9222/json/version | head -3
```

- [ ] **Step 3: 基线运行（红灯，记录现状）**

Run: `node scripts/verify-video-page.mjs all`
Expected: **FAIL** —— 修改前行为：
- `desktop 整页未被拖动` FAIL（实测 winScrollY=155）
- `mobile 文档无溢出` FAIL（实测 868 > 844）
- `mobile 初始 window.scrollY==0` FAIL（实测 13）
- `间隙 40.0s 保留上一条=16` FAIL（实测 -1）
- 其余项（字幕置顶 topGap、全屏失败路径）本次可能通过，但该脚本在改动完成后必须**全绿**。

- [ ] **Step 4: 提交**

```bash
cd /home/duxuan/duxuan/code/english/shadow_voice
git add scripts/verify-video-page.mjs
git commit -m "test: 新增视频页字幕跟随/全屏 CDP 验证脚本"
```

---

### Task 2: 字幕跟随（桌面+移动）+ 间隙保持 + h-dvh

**Files:**
- Modify: `src/pages/VideoDetail.jsx`（4 处：`activeSubIndex` 跟踪 effect、桌面自动滚动 effect、移动自动滚动 effect、移动端外层容器 className）

**Interfaces:**
- Consumes: Task 1 的 `scripts/verify-video-page.mjs`
- Produces: 无对外接口变化（纯行为修复）

- [ ] **Step 1: 间隙保持 —— 替换 activeSubIndex 跟踪 effect**

原文（唯一匹配）：
```js
  useEffect(() => { if (!video || !video.subtitles) return; setActiveSubIndex(video.subtitles.findIndex(s => currentTime >= s.startTime && currentTime <= s.endTime)) }, [currentTime, video])
```
替换为：
```js
  // 有匹配字幕时更新；落在时间间隙（无匹配）时保留上一条，避免高亮消失与跟随跳变
  useEffect(() => {
    if (!video || !video.subtitles) return
    const idx = video.subtitles.findIndex(s => currentTime >= s.startTime && currentTime <= s.endTime)
    if (idx >= 0) setActiveSubIndex(idx)
  }, [currentTime, video])
```

- [ ] **Step 2: 桌面端温和跟随 —— 替换桌面自动滚动 effect**

原文（唯一匹配）：
```js
  // Auto-scroll to active subtitle (desktop) — center active in viewport
  useEffect(() => {
    if (sidebarTab !== 'transcript' || activeSubIndex < 0 || !scrollContainerRef.current) return
    const el = scrollContainerRef.current.querySelector(`#sub-item-${activeSubIndex}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeSubIndex, sidebarTab])
```
替换为：
```js
  // Auto-scroll to active subtitle (desktop) — 温和跟随：仅当当前句滚出可视区时，
  // 滚动到字幕区顶部（留 8px）。用容器 scrollTo（而非 scrollIntoView），
  // 避免连带滚动窗口导致整页被拖动。
  useEffect(() => {
    if (sidebarTab !== 'transcript' || activeSubIndex < 0 || !scrollContainerRef.current) return
    const container = scrollContainerRef.current
    const el = container.querySelector(`#sub-item-${activeSubIndex}`)
    if (!el) return
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const topGap = eRect.top - cRect.top
    const bottomGap = cRect.bottom - eRect.bottom
    if (topGap < 0 || bottomGap < 0) {
      container.scrollTo({ top: container.scrollTop + topGap - 8, behavior: 'smooth' })
    }
  }, [activeSubIndex, sidebarTab])
```

- [ ] **Step 3: 移动端温和跟随 —— 替换移动自动滚动 effect**

原文（唯一匹配）：
```js
  // Auto-scroll to active subtitle (mobile) — center active + trigger on play
  useEffect(() => {
    if (mobileTab !== 'transcript' || activeSubIndex < 0 || !mobileScrollRef.current) return
    const el = mobileScrollRef.current.querySelector(`[data-mobile-sub-index="${activeSubIndex}"]`)
    if (el) {
      const container = mobileScrollRef.current
      const elTop = el.offsetTop
      const elBottom = elTop + el.offsetHeight
      const viewTop = container.scrollTop
      const viewBottom = viewTop + container.clientHeight
      // Only scroll if element is NOT fully visible in the viewport
      const isVisible = elTop >= viewTop && elBottom <= viewBottom - 80 // 80px margin for bottom bar
      if (!isVisible) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [activeSubIndex, mobileTab, playing])
```
替换为：
```js
  // Auto-scroll to active subtitle (mobile) — 温和跟随：仅当当前句滚出可视区时
  // （底部固定操作栏保留 80px 余量）滚动到字幕区顶部（留 8px）。用容器 scrollTo
  // 而非 scrollIntoView，避免整页被拖动；用 getBoundingClientRect 而非 offsetTop
  // （offsetTop 相对 body，坐标系与容器 scrollTop 不一致）。
  useEffect(() => {
    if (mobileTab !== 'transcript' || activeSubIndex < 0 || !mobileScrollRef.current) return
    const container = mobileScrollRef.current
    const el = container.querySelector(`[data-mobile-sub-index="${activeSubIndex}"]`)
    if (!el) return
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const topGap = eRect.top - cRect.top
    const bottomGap = cRect.bottom - eRect.bottom
    if (topGap < 0 || bottomGap < 80) {
      container.scrollTo({ top: Math.max(0, container.scrollTop + topGap - 8), behavior: 'smooth' })
    }
  }, [activeSubIndex, mobileTab, playing])
```

- [ ] **Step 4: 移动端页面防拖 —— 外层容器 h-screen → h-dvh**

原文（唯一匹配）：
```js
      <div className="flex flex-col h-screen bg-white overflow-hidden">
```
替换为：
```js
      <div className="flex flex-col h-dvh bg-white overflow-hidden">
```
（`h-dvh` = `height:100dvh`，动态视口高度，消除手机上 100vh 比可视区高的文档溢出）

- [ ] **Step 5: 重建 + 全量验证**

```bash
cd /home/duxuan/duxuan/code/english/shadow_voice && npm run build
pkill -f "node server/index.cjs"; setsid node server/index.cjs > /tmp/sv-server.log 2>&1 < /dev/null &
sleep 2
node scripts/verify-video-page.mjs all
```
Expected: 除 Task 3 涉及的"全屏失败路径"检查外，**其余全部 PASS**（desktop 8 项 / mobile 9 项）。

- [ ] **Step 6: 提交**

```bash
git add src/pages/VideoDetail.jsx
git commit -m "fix: 字幕温和跟随置顶对齐、间隙保留高亮、移动端 h-dvh 防整页拖动"
```
（注意：该提交会一并纳入 VideoDetail.jsx 中此前未提交的在途改动——完成后向用户说明。）

---

### Task 3: 全屏横屏重写

**Files:**
- Modify: `src/pages/VideoDetail.jsx`（`toggleFullscreen`、fullscreenchange 监听 effect、`<video>` className）

**Interfaces:**
- Consumes: Task 2 的代码（`isMobile`、`playerContainerRef`、`videoRef`、`isFullscreen` 均为既有状态）
- Produces: 无对外接口变化

- [ ] **Step 1: 替换 toggleFullscreen 与 fullscreenchange 监听**

原文（唯一匹配）：
```js
  const toggleFullscreen = () => {
    if (!playerContainerRef.current) return
    if (!isFullscreen) { playerContainerRef.current.requestFullscreen(); setIsFullscreen(true) }
    else { document.exitFullscreen(); setIsFullscreen(false) }
  }
  useEffect(() => { const h = () => setIsFullscreen(!!document.fullscreenElement); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h) }, [])
```
替换为：
```js
  const toggleFullscreen = async () => {
    const container = playerContainerRef.current
    const vid = videoRef.current
    if (!container || !vid) return
    // 已在全屏 → 退出并解除横屏锁定
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen()
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
      } catch { /* ignore */ }
      try { window.screen?.orientation?.unlock?.() } catch { /* ignore */ }
      setIsFullscreen(false)
      return
    }
    // iPhone Safari：不支持任意元素全屏 → 原生视频全屏（自动横屏）
    if (isMobile && typeof vid.webkitEnterFullscreen === 'function') {
      vid.webkitEnterFullscreen()
      setIsFullscreen(true)
      return
    }
    try {
      const req = container.requestFullscreen || container.webkitRequestFullscreen
      if (typeof req !== 'function') return
      await req.call(container)
      // 安卓：锁定横屏，避免竖屏全屏显示成一条小画面
      if (isMobile && window.screen?.orientation?.lock) {
        try { await window.screen.orientation.lock('landscape') } catch { /* 部分浏览器/非安全上下文不允许 */ }
      }
      setIsFullscreen(true)
    } catch { /* 浏览器拒绝（如非 HTTPS）→ 不置状态 */ }
  }
  useEffect(() => {
    const h = () => setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement))
    const hEnd = () => setIsFullscreen(false) // iOS 原生播放器关闭时复位
    document.addEventListener('fullscreenchange', h)
    document.addEventListener('webkitfullscreenchange', h)
    document.addEventListener('webkitendfullscreen', hEnd)
    return () => {
      document.removeEventListener('fullscreenchange', h)
      document.removeEventListener('webkitfullscreenchange', h)
      document.removeEventListener('webkitendfullscreen', hEnd)
    }
  }, [])
```

- [ ] **Step 2: 视频全屏时 object-contain 防裁切**

原文（唯一匹配）：
```js
        className="w-full h-full object-cover cursor-pointer"
```
替换为：
```js
        className={`w-full h-full ${isFullscreen ? 'object-contain' : 'object-cover'} cursor-pointer`}
```

- [ ] **Step 3: 重建 + 验证全屏失败路径**

```bash
cd /home/duxuan/duxuan/code/english/shadow_voice && npm run build
pkill -f "node server/index.cjs"; setsid node server/index.cjs > /tmp/sv-server.log 2>&1 < /dev/null &
sleep 2
node scripts/verify-video-page.mjs all
```
Expected: **全部 PASS**（desktop 9 项 / mobile 10 项，含"全屏失败后视频仍 object-cover"）。

- [ ] **Step 4: 提交**

```bash
git add src/pages/VideoDetail.jsx
git commit -m "fix: 全屏分平台处理（iOS 原生横屏/安卓横屏锁定/桌面降级），失败不置状态"
```

---

### Task 4: 最终回归与收尾

**Files:**
- Modify: 无（纯验证 + 收尾提交）

**Interfaces:**
- Consumes: Task 1-3 全部改动

- [ ] **Step 1: 干净环境全量回归**（杀掉旧 chromium/服务，全部重启后跑）

```bash
cd /home/duxuan/duxuan/code/english/shadow_voice
pkill -f chromium; pkill -f "node server/index.cjs"; sleep 1
npm run build
setsid node server/index.cjs > /tmp/sv-server.log 2>&1 < /dev/null &
setsid /snap/bin/chromium --headless=new --remote-debugging-port=9222 --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required --window-size=1440,900 about:blank > /tmp/sv-chromium.log 2>&1 < /dev/null &
sleep 5
node scripts/verify-video-page.mjs all
```
Expected: `ALL PASS`（desktop 9 项 + mobile 10 项，共 19 项）。

- [ ] **Step 2: lint 检查**

```bash
npm run lint 2>&1 | tail -5
```
Expected: **不新增 error**。注意：基线（修改前）已有 14 个 error / 10 个 warning（来自在途改动，如 `react-hooks/purity`），以"修改前后对比无新增"为准。

- [ ] **Step 3: 收尾提交**（若 Task 2/3 提交后无遗留代码改动，本步可跳过）

```bash
git status --short
git add -A && git commit -m "chore: 字幕跟随与全屏修复收尾" || echo "无遗留改动"
```

- [ ] **Step 4: 向用户交付真机验证清单**（不在本会话范围，需用户在真实设备确认）
- iPhone Safari：点全屏 → 原生播放器横屏播放；关闭播放器后状态复位、可再次点全屏。
- 安卓 Chrome：点全屏 → 全屏且横屏（如设备未开自动旋转，仍应横屏显示）。
- 桌面 Chrome/Edge/Firefox：点全屏 → 视频全屏（16:9，无裁切）。
- 手机/电脑通过 `http://局域网IP:3001` 访问时：全屏/横屏/麦克风可能被浏览器禁用（非安全上下文）——此为部署层事项，建议后续挂 HTTPS。
- 播放中字幕跟随：当前句滚出底部后出现在字幕区顶部，整页不再上下跳动；可手动向上翻看旧字幕不会被抢回。
