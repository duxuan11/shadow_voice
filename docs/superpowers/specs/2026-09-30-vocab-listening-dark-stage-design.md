# 生词听练「沉浸式深色舞台」设计文档（A 档）

日期：2026-09-30
分支：feat/vocab-listening-practice
状态：待实现
关联：`2026-09-30-vocab-listening-interaction-polish-design.md`（B 档交互打磨，已实现）

## 背景与目标

B 档只做到「浅色一体化 + 轻动效」，与参考站 ComeKey 的沉浸式观感差距明显。本次按
**A 档**重做生词听练页的视觉：整页深色沉浸主题、3D 卡片舞台、卡后光晕/斜向高光、
更强的连击与完成页；并**重做拼写输入区**——不再是普通输入框，而是把答案拆成
「逐词下划线槽位」，判定直接显示在槽位上。

**仅借鉴参考站的交互思路，不复制其代码、样式表、类名或文案。**

**明确不做**：不改后端/数据模型/统计口径；不改视频听写页；不加音效；不加新依赖。

## 范围

- **只改**：`src/pages/VocabPracticePage.jsx`、`src/index.css`、`src/App.jsx`
  （隐藏全局导航栏），新增 `src/components/SpellSlots.jsx`、
  `src/utils/spellSlots.js`(+test)。
- **不改**：后端、`DictationPage.jsx`、`src/utils/spellCheck.js`、其他页面。
- 零新依赖；动效全部 CSS。

## 视觉设计（沉浸式深色）

### 整页与舞台

- 整页背景：深靛蓝 → 紫黑多层渐变（`#0b1020 → #131a35 → #1a1440`），叠加极淡径向光晕。
- 舞台：居中透视容器（`perspective`），卡片进出场 `translateY(36px) + scale(0.9)
  + rotateX(≈12deg)` → 归位，约 0.5s `cubic-bezier(0.16,1.2,0.3,1)`。
- 卡片：深色卡面（约 `#161d33`，带轻微渐变）、圆角 28px、大投影、
  `min-height ≈ 520px`、白色高对比文字；卡后一层径向光晕，卡面一道极淡斜向高光。
- 配色：主色靛蓝 `#6366f1` → 紫 `#8b5cf6`；播放/聚焦态青色 `#22d3ee`；避免纯黑。

### 顶部 / 进度 / 完成页 / 帮助

- 顶部工具栏：类型标签 + 渐变进度条 + 右上角帮助图标（深色图标按钮）。
- 连击浮层：更大、带发光与 `scale` 弹跳。
- 完成页：深色发光统计卡（已练 / 正确 / 正确率 / 最长连击）+ 强化 CTA。
- 帮助面板与 tooltip：深色主题。
- `prefers-reduced-motion`：关闭重动效。

### 导航栏

- `/vocab/practice` 隐藏全局导航栏（全屏沉浸，仅保留页内「返回」按钮）。
  在 `App.jsx` 增加该路径判断，导航栏整体隐藏、内容区去掉内边距。

## 拼写输入区（核心改动）

新增受控组件 `src/components/SpellSlots.jsx`：

- 把期望答案按空格拆成 **N 个无边框下划线槽位**（`N = max(1, 期望词数)`），
  大号加粗（`clamp(26px, 4vw, 40px)`），逐词输入。
- 槽宽随输入增长（`ch` 单位，最小约 4ch），**不暴露期望词长**。
- 自动聚焦第一槽。

### 交互

- `空格` / `→`：跳下一槽（`空格` 仅在无 Ctrl/⌘/Alt 时处理，避免抢占重听快捷键）。
- `←` / 空槽时 `退格`：回上一槽。
- 最后一槽 `Enter`：提交；非最后一槽 `Enter`：跳下一槽。
- 粘贴：把粘贴文本按空格分配进各槽（从当前槽开始，超出部分并入最后一槽）。
- 槽位内对 `Enter/空格/方向键` 调用 `stopPropagation()`，避免与全局快捷键冲突；
  `Tab`、`Ctrl+Space`、`Alt+R`、`Ctrl+H`、`Esc` 不拦截，交给全局处理。

### 判定与展示

- 提交后判定直接呈现在槽位上：
  - 正确 = 绿色下划线；
  - 错误 = 红色下划线，并在该槽下方显示正确词；
  - 遗漏（空槽）= 黄色虚线槽。
- 「显示答案」把正确词填入各槽并整体标黄（不判对错）。
- 槽位在练习全程保持挂载，提交/显示答案时变为只读并着色，避免布局跳动。
- 移除原先独立的一行「逐词比对结果」与整句「正确答案」行：答案已直接体现在槽位上（错误槽下方显示正确词，显示答案后槽内即正确答案）。

### 组件接口

```js
<SpellSlots
  expectedWords={string[]}   // 期望词（用于槽数/标黄/错误提示）
  value={string[]}           // 受控槽值
  onChange={(next: string[]) => void}
  onSubmit={() => void}      // 最后一槽 Enter
  disabled={boolean}         // 提交后/显示答案后只读
  statuses={Array<{ status:'correct'|'wrong'|'missing', expected:string, user:string }> | null}
  revealed={boolean}
/>
```

## 纯函数模块 `src/utils/spellSlots.js`

零依赖、可单测：

```js
splitToSlots(expected) -> string[]        // 期望词数组（去标点、合并空白）
slotCountFor(expected) -> number          // max(1, splitToSlots(expected).length)
compareSlots(values, expectedWords)
  -> Array<{ status:'correct'|'wrong'|'missing', expected:string, user:string }>
distributePaste(text, count, startIndex = 0) -> string[]  // 长度 = count
joinSlots(values) -> string               // 组装回整句（用于提交/快照）
slotsAllCorrect(statuses) -> boolean
```

- `compareSlots`：空槽 → `missing`；`normalize(用户) === normalize(期望)` → `correct`；
  否则 `wrong`。由于槽数固定，「多余」情形不会出现。
- 复用 `spellCheck.js` 的 `normalizeText/tokenize`（只读复用，不改该文件）。

## 与现有逻辑的关系

- **统计口径不变**：仍只有「首次提交」写入后端；熟练度公式不变。
- **上一题**：快照由 `userInput: string` 改为 `slotValues: string[]`（或 `joinSlots` 后的字符串），
  恢复时重新填入各槽。
- **连击 / 快捷键**：连击规则不变；`Tab` 显示答案、`Ctrl+Space`/`Alt+R` 重听、
  `Ctrl+H` 中文、`1/3/4`、`←` 上一题、`?` 帮助、`Esc` 返回全部保留。
- **`resolveShortcut`**：不改；槽位组件负责 `Enter/空格/方向键`。

## 移动端

- 单列布局，槽位自动换行；点槽位唤起键盘。
- 降低 3D/光晕强度，仅做轻微淡入；连击浮层与底部操作区适配安全区
  （`env(safe-area-inset-bottom)`）。
- 可点元素 ≥ 44px、`touch-action: manipulation`、不依赖 hover。

## 测试与验证

- 新增 `src/utils/spellSlots.test.js`：槽位拆分、`compareSlots` 三种状态、
  `distributePaste`（含超出并入末槽、从中间开始）、`joinSlots`、空输入。
- 回归：`node --test "src/utils/*.test.js"` 全绿。
- `npx eslint`（改动文件）无 error；`npm run build` 成功。
- 无浏览器环境：动效/3D/手机端走手动冒烟清单。

## 改动文件

**新增**
- `src/components/SpellSlots.jsx`
- `src/utils/spellSlots.js`
- `src/utils/spellSlots.test.js`

**修改**
- `src/pages/VocabPracticePage.jsx`
- `src/index.css`
- `src/App.jsx`
- `README.md`（补一句拼写输入说明）

## 自查记录

- 参考站仅用于理解交互；深色配色、3D 参数、槽位类名、动画曲线均为本项目自定，
  未复制其样式表或代码。
- 与既有约束一致：不改后端与统计口径、不改视频听写页、无新依赖、无音效、
  ≥44px、reduced-motion 兜底。
- 已知取舍：槽位会暴露「词的数量」（听写提示）；「多余」判定在槽位模式下不再出现。
