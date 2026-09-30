# 生词听练「交互与视觉打磨」设计文档

日期：2026-09-30
分支：feat/vocab-listening-practice
状态：待实现
关联：`2026-09-30-vocab-listening-practice-design.md`（听练一体基础功能，已实现）

## 背景与目标

生词听练页（`src/pages/VocabPracticePage.jsx`）功能已完整，但视觉与键盘操作偏
朴素。参考 ComeKey「听音拼写」的交互语言（**仅借鉴交互与观感思路，不复制其代码、
样式或键位**），把听练页打磨成：观感更完整、键盘可全流程操作、PC 与手机都顺手。

**基础档位**：以「适度借鉴」为基线，只在三处向「接近参考观感」靠拢——
拼写输入区、悬浮提示、背景一体化。

**明确不做**：不引入 3D 透视、不大面积发光、不加音效、不加新依赖、不改视频听写页。

## 范围

- **仅改**：生词听练页（`VocabPracticePage.jsx`、`src/index.css`、新增快捷键纯模块）。
- **不改**：视频听写页（`DictationPage.jsx`）、后端、数据模型、统计口径、路由。
- 继续在 `feat/vocab-listening-practice` 分支迭代（上一批工作尚未合并）。

## 技术方案

纯 CSS 动画 + 一个可单测的纯函数快捷键模块，页面只负责「监听事件 → 调用
`resolveShortcut` → 执行 action」。零新依赖，快捷键逻辑进现有 `node --test`。

备选（不采用）：引入 framer-motion（多依赖）；把快捷键逻辑写在组件里（不可测）。

## 快捷键系统

新增纯模块 `src/utils/vocabShortcuts.js`。

### 接口

```js
// 返回动作 id 或 null（null = 不拦截，交给浏览器/输入框）
resolveShortcut({
  key,        // KeyboardEvent.key
  ctrlKey,    // boolean
  metaKey,    // boolean
  shiftKey,   // boolean
  phase,      // 'setup' | 'typing' | 'review' | 'finished'
  revealed,   // 对照态是否已「显示答案」
  hasResult,  // 是否已提交过（有比对结果）
  helpOpen,   // 快捷键面板是否打开
}) -> Action | null

// Action ∈
// 'start' | 'submit' | 'replay' | 'toggleChinese' | 'reveal'
// | 'retry' | 'next' | 'prev' | 'help' | 'closeHelp' | 'back' | 'again' | null
```

导出供「帮助面板」与「键帽提示」渲染的数据：

```js
SHORTCUT_GROUPS  // [{ title, items: [{ keys: ['Enter'], label: '提交' }] }]
```

模块为纯函数、零依赖，不读 DOM，便于单测。

### 键位表

**答题中（`phase === 'typing'`）**

| 按键 | 动作 |
| --- | --- |
| `Enter`（无 Shift） | `submit`（输入为空则不提交，由页面守卫） |
| `Shift + Enter` | 不拦截（换行） |
| `Ctrl/⌘ + Space` 或 `Alt + R` | `replay` |
| `Ctrl/⌘ + H` | `toggleChinese` |
| `Esc` | `back` |

**对照中（`phase === 'review'`）**

| 按键 | 动作 |
| --- | --- |
| `Enter` / `Space` | `next` |
| `1` | `replay` |
| `2` | `reveal`（仅在尚未显示答案时有意义） |
| `3` | `retry` |
| `4` | `next` |
| `←` | `prev` |
| `Esc` | `back` |

**全局**

| 按键 | 动作 |
| --- | --- |
| `?`（`Shift+/`）或 `/` | `help`（打开面板；已打开时返回 `null`，不重复打开） |
| `Esc` | `helpOpen === true` → `closeHelp`；否则 `back` |
| `Enter`（`setup`） | `start`（所选类型为空时不启动） |
| `Enter`（`finished`） | `again` |

**拦截规则**
- 只在「输入框未聚焦」时处理会与打字冲突的键（`?`、`/`、数字、`Space`、方向键）。
  `Enter` / `Shift+Enter` / `Ctrl+Space` / `Alt+R` / `Ctrl+H` 在输入框聚焦时也处理。
- `Ctrl/⌘ + Space` 在 Windows 会切换输入法，因此额外支持 `Alt + R`。
- 所有处理到的按键调用 `preventDefault()`，避免滚动/刷新等默认行为。

## 视觉设计

### 背景一体化

整页替换现在的纯色 `#f8fafc`，改为与卡片同色系的**浅色柔和渐变**：

```
background: linear-gradient(180deg, #eef2ff 0%, #f8fafc 42%, #f5f3ff 100%);
```

卡片：白底、`border: 1px solid #e8ecf7`、`border-radius: 20px`、
`box-shadow: 0 18px 44px rgba(40, 58, 110, 0.10)`，卡片后方叠加一层**极淡**径向光晕
（`radial-gradient(... rgba(99,102,241,0.10), transparent 70%)`，低透明、非大面积）。

### 卡片进出场

出题切换时卡片播放入场动画（轻量，不做 3D）：

```css
@keyframes vocabCardIn {
  from { opacity: 0; transform: translateY(16px) scale(0.97); }
  to   { opacity: 1; transform: none; }
}
```
时长 ~0.3s，`ease-out`；答案区/比对结果错峰淡入（`animation-delay` 60–120ms）。

### 拼写输入区（往 A 靠）

- 字号 22px、内边距加大、圆角 14px。
- 聚焦：`border-color: #2563eb` + `box-shadow: 0 0 0 4px rgba(37,99,235,0.12)`。
- 下方一排**键帽提示**：`Enter 提交` `Shift+Enter 换行` `Ctrl+Space 重听`。

### 悬浮提示（往 A 靠）

- 图标按钮：`:hover`/`:focus-visible` 出 tooltip，内容为「动作名 + 键帽」。用
  `data-tip` + `::after` 纯 CSS 实现，避免额外状态。
- 正确答案区：hover 时浮出小气泡，显示**音标 + 中文释义**（不点击、不打断输入）。
  手机端不依赖 hover，改用「显示中文」开关。

### 顶部与进度

- 类型标签 + 步骤点（已答/当前/未答）+ 细进度条（`#2563eb → #7c3aed` 渐变）。

### 连击反馈

- 底部居中浮层，连续「首次答对」累计显示 `连击 x N`，`scale` 弹出 + 淡出，约 1s
  后自动隐藏；答错清零且不显示。
- 移动端位置上移，避免被虚拟键盘/安全区遮挡。

### 完成页

- 统计卡四项：**已练 / 正确 / 正确率 / 最长连击**。
- 操作：`再来一轮`、`返回个人中心`。
- 手机端统计卡单列。

### 快捷键帮助面板

- 浮层分组渲染 `SHORTCUT_GROUPS`（答题中 / 对照中 / 全局）。
- 触发：`?` / `/` 或右上角帮助按钮；`Esc`、点击遮罩、关闭按钮均可关闭。

## 手机端

- 隐藏键帽提示与 hover tooltip，保留按钮、帮助面板入口。
- 输入区字号自适应，操作按钮自动换行；完成页统计卡单列。
- 所有可点元素 ≥ 44px、`touch-action: manipulation`；底部适配安全区
  （`padding-bottom: env(safe-area-inset-bottom)`）。

## 行为语义

- **上一题**：回到上一题并**恢复该题此前的输入与比对结果**（本轮内每题的作答快照）；
  统计不重复计入（仍「首次提交才计」）。到第一题时按钮禁用。
- **连击**：仅「首次答对」累计；`显示答案`、`再练一次`不影响连击；答错清零；完成页
  展示本轮最长连击。
- **统计口径不变**：熟练度仍 `round(correct_count / practice_count * 100)`，仅首次提交
  写入后端。
- **取消输入守卫**：`submit` 仍要求非空输入，保持与基础版一致。

## 测试与验证

- 新增 `src/utils/vocabShortcuts.test.js`：覆盖各 `phase` × 按键 × 修饰键的映射，
  以及帮助面板/上一题/连击相关返回。
- 回归：`node --test "src/utils/*.test.js"` 全绿。
- `npx eslint src/pages/VocabPracticePage.jsx src/utils/vocabShortcuts.js` 无 error。
- `npm run build` 成功。
- 仓库无 DOM 测试框架，动效与悬浮走手动冒烟清单（桌面 + 手机视口）。

## 改动文件

**新增**
- `src/utils/vocabShortcuts.js`
- `src/utils/vocabShortcuts.test.js`

**修改**
- `src/pages/VocabPracticePage.jsx`（接入快捷键、连击、上一题、帮助面板、键帽/悬浮）
- `src/index.css`（背景一体化、卡片动效、输入区、连击、完成页、帮助面板、移动端）
- `README.md`（补一句快捷键/交互说明，可选）

## 自查记录

- 参考站仅用于理解交互与观感；本设计中的颜色、键位、类名、动画参数均为本项目自行
  定义，未复制其代码或样式表。
- 与既有 Global Constraints 一致：不改视频听写页、不改统计口径、≥44px、无新依赖。
