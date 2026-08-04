# 字幕跟随 + 全屏横屏修复 — 设计规格

日期：2026-08-04
状态：已批准（用户确认，含第 5 点间隙高亮保持）

## 背景与问题

用户反馈（手机端 + 网页端）：

1. **字幕列表每次把当前句"居中"显示，会把整个网页往下拖动**，希望当前字幕一直能跟随在字幕区顶部，且不拖动整页。
2. **手机端点击全屏，视频无法横屏**；并询问电脑端全屏是否有效。

## 根因（无头 Chromium 实测证据）

| 指标 | 桌面端 (1440×900) | 手机端 (390×844) |
|---|---|---|
| 字幕切换后 `window.scrollY` | 0 → **155**（整页被拖） | 13 → **24**（也被拖） |
| 字幕容器 scrollTop | 0 → 2502（容器正常滚动） | 0 → 2310 |
| 文档是否可滚动 | 是（内容 1146 > 视口 813） | **是**（868 > 844） |

- **`Element.scrollIntoView()` 会滚动所有可滚动祖先**（包括 html/body 窗口），这是整页被拖的直接原因；`block:'center'` 又要求每次居中，加剧跳动。
- 手机端外层 `h-screen`（100vh）比可视区高约 24px → 文档本身可滚动，物理上拖得动。
- 字幕时间轴存在**间隙**（如 38.37s→40.13s 空档），播放到间隙时 `activeSubIndex=-1` → 高亮消失、跟随跳变。
- 全屏：iOS Safari 不支持任意元素 `requestFullscreen`（需 `video.webkitEnterFullscreen()`）；安卓支持元素全屏但默认竖屏（需 `screen.orientation.lock('landscape')`）；桌面 Chrome/Edge/Firefox/Safari16.4+ 有效，老 Safari 需 `webkitRequestFullscreen` 降级。当前代码无任何降级/横屏处理，且失败时状态仍被置 true。
- 部署为纯 HTTP（3001），手机经局域网 IP 访问属非安全上下文，全屏/旋转锁/麦克风可能被浏览器禁用（提示用户，非本次代码改动）。

## 设计方案

改动范围：`src/pages/VideoDetail.jsx`（唯一需要改动的文件）。

### 1. 桌面端字幕跟随（温和 + 置顶对齐 + 只滚容器）

替换 `scrollIntoView({block:'center'})` 为手动 `container.scrollTo`：

- 用 `getBoundingClientRect()` 计算当前句相对容器可视区的位置（`topGap`/`bottomGap`）。
- 温和跟随：当前句完全可见 → 不滚动；滚出可视区（`topGap<0 || bottomGap<0`）→ 滚动到**字幕区顶部**（留 8px）。
- `scrollTo` 只作用于字幕容器，不会滚动窗口 → 整页不再被拖动。

### 2. 移动端字幕跟随

同上逻辑，容器为 `mobileScrollRef`，底部预留 80px（固定操作栏遮挡）。顺带修复现有 `el.offsetTop` 坐标系错误（offsetParent 是 body，与 `container.scrollTop` 不同坐标系），统一用 `getBoundingClientRect`。保留 `playing` 依赖（播放时触发一次跟随）。

### 3. 手机端页面防拖

移动端外层容器 `h-screen` → `h-dvh`（动态视口高度），消除文档溢出（实测 868 > 844），页面物理上不可拖。保留 `overflow-hidden`。

### 4. 全屏横屏

重写 `toggleFullscreen`：

- 退出路径：`document.exitFullscreen`/`webkitExitFullscreen` + `screen.orientation.unlock()` + 复位状态。
- iOS：`isMobile && vid.webkitEnterFullscreen` → 原生视频全屏（自动横屏）；监听 `webkitendfullscreen` 复位状态。
- 安卓：`container.requestFullscreen()`（含 `webkitRequestFullscreen` 降级）后 `screen.orientation.lock('landscape')` 强制横屏；失败（try/catch）不置状态。
- 视频元素：全屏时 `object-cover` → `object-contain`（防裁切）。

### 5. 字幕间隙高亮保持

`activeSubIndex` 更新逻辑：仅在有匹配字幕时更新；无匹配（间隙）时**保留上一条**，避免 -1 闪烁与跟随跳变。

## 测试计划

1. 无头 Chromium CDP 复测：
   - seek 41s：`window.scrollY` 桌面保持 0、移动端不变；当前句 top ≈ 容器 top+8（置顶而非居中）；容器 scrollTop 正常变化。
   - 移动端 `docScrollH == docClientH`（无文档溢出）。
   - seek 40.0s（间隙）：`activeSubIndex` 保持 16 而非 -1。
   - 全屏失败路径：状态不被置 true（无头环境 `requestFullscreen` 会抛 Permissions 错误，恰好可验证）。
2. 真机验证（需用户）：iPhone 原生播放器横屏、安卓全屏横屏、桌面全屏。

## 非目标

- 不引入 HTTPS（部署层事项，另行提示）。
- 不改动其他页面。
- 不做字幕数据补齐（间隙保留策略已足够）。
