// 生词听练页键盘快捷键映射（纯函数，零依赖，不读 DOM，便于单测）。
// 页面只负责监听 keydown → 调用 resolveShortcut → 执行返回的 action。

export const SHORTCUT_GROUPS = [
  {
    title: '答题中',
    items: [
      { keys: ['Enter'], label: '提交' },
      { keys: ['Shift', 'Enter'], label: '换行' },
      { keys: ['Ctrl/⌘', 'Space'], label: '再听一次' },
      { keys: ['Alt', 'R'], label: '再听一次' },
      { keys: ['Ctrl/⌘', 'H'], label: '显示 / 隐藏中文' },
      { keys: ['Esc'], label: '返回' },
    ],
  },
  {
    title: '对照中',
    items: [
      { keys: ['Enter'], label: '下一题' },
      { keys: ['Space'], label: '下一题' },
      { keys: ['1'], label: '再听一次' },
      { keys: ['2'], label: '显示答案' },
      { keys: ['3'], label: '再练一次' },
      { keys: ['4'], label: '下一题' },
      { keys: ['←'], label: '上一题' },
      { keys: ['Esc'], label: '返回' },
    ],
  },
  {
    title: '全局',
    items: [
      { keys: ['?'], label: '快捷键帮助' },
      { keys: ['Esc'], label: '关闭帮助 / 返回' },
      { keys: ['Enter'], label: '开始练习 / 再来一轮' },
    ],
  },
]

/**
 * 把一次按键解析成动作 id；返回 null 表示不拦截（交给浏览器/输入框）。
 * inputFocused 为 true 时只处理不会与打字冲突的键。
 */
export function resolveShortcut({
  key,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
  altKey = false,
  phase = 'setup',
  revealed = false,
  hasResult = false,
  helpOpen = false,
  inputFocused = false,
} = {}) {
  const mod = ctrlKey || metaKey
  const plain = !ctrlKey && !metaKey && !altKey && !shiftKey

  // Esc 在任何聚焦状态下都可用：优先关面板，否则返回
  if (key === 'Escape') return helpOpen ? 'closeHelp' : 'back'
  // 帮助面板打开时吞掉其他按键，避免误触题目操作
  if (helpOpen) return null

  if (inputFocused) {
    // 输入框聚焦：只处理不产生可见字符的键
    if (phase === 'typing') {
      if (key === 'Enter') {
        if (shiftKey || mod || altKey) return null
        return 'submit'
      }
      if (mod && key === ' ') return 'replay'
      if (altKey && (key === 'r' || key === 'R')) return 'replay'
      if (mod && (key === 'h' || key === 'H')) return 'toggleChinese'
    }
    return null
  }

  // 以下为「输入框未聚焦」
  if (key === '?' || key === '/') return 'help'

  if (phase === 'typing') {
    if (key === 'Enter') {
      if (shiftKey) return null
      return 'submit'
    }
    if (mod && key === ' ') return 'replay'
    if (altKey && (key === 'r' || key === 'R')) return 'replay'
    if (mod && (key === 'h' || key === 'H')) return 'toggleChinese'
    return null
  }

  if (phase === 'review') {
    if (key === 'Enter' || key === ' ') return 'next'
    if (key === 'ArrowLeft' && plain) return 'prev'
    if (key === '1' && plain) return 'replay'
    if (key === '2' && plain) return hasResult || revealed ? null : 'reveal'
    if (key === '3' && plain) return 'retry'
    if (key === '4' && plain) return 'next'
    if (altKey && (key === 'r' || key === 'R')) return 'replay'
    if (mod && (key === 'h' || key === 'H')) return 'toggleChinese'
    return null
  }

  if (phase === 'setup') return key === 'Enter' ? 'start' : null
  if (phase === 'finished') return key === 'Enter' ? 'again' : null
  return null
}
