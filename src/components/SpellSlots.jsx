import { useEffect, useRef } from 'react'
import { distributePaste } from '../utils/spellSlots'

// 逐词下划线槽位输入。
// 槽位内处理 Enter/空格/方向键/退格，并 stopPropagation，避免与全局快捷键冲突；
// Tab / Ctrl+Space / Alt+R / Ctrl+H / Esc 不拦截，交给页面全局监听。
export default function SpellSlots({
  expectedWords = [],
  value = [],
  onChange,
  onSubmit,
  disabled = false,
  statuses = null,
  revealed = false,
}) {
  const refs = useRef([])
  const slots = expectedWords.length > 0 ? expectedWords.length : Math.max(1, value.length)
  const readOnly = disabled || revealed

  useEffect(() => {
    if (!disabled && refs.current[0]) refs.current[0].focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const focusSlot = (i) => {
    const idx = Math.max(0, Math.min(slots - 1, i))
    const el = refs.current[idx]
    if (el) { el.focus(); el.select?.() }
  }

  const setAt = (i, v) => {
    const next = Array.from({ length: slots }, (_, k) => value[k] ?? '')
    next[i] = v
    onChange?.(next)
  }

  const handleKeyDown = (e, i) => {
    if (readOnly) return
    const modified = e.ctrlKey || e.metaKey || e.altKey
    if (e.key === ' ' && !modified) {
      e.preventDefault(); e.stopPropagation()
      if (i < slots - 1) focusSlot(i + 1)
      return
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); focusSlot(i + 1); return }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); focusSlot(i - 1); return }
    if (e.key === 'Backspace' && !(value[i] ?? '')) { e.preventDefault(); e.stopPropagation(); focusSlot(i - 1); return }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      if (i < slots - 1) focusSlot(i + 1)
      else onSubmit?.()
      return
    }
    // 其余按键（含 Tab/Ctrl+Space/Alt+R/Ctrl+H/Esc）冒泡给全局
  }

  const handlePaste = (e, i) => {
    if (readOnly) return
    const text = e.clipboardData?.getData('text') ?? ''
    if (!text || !/\s/.test(text.trim())) return
    e.preventDefault()
    onChange?.(distributePaste(text, slots, i, value))
  }

  return (
    <div className="spell-slots" role="group" aria-label="拼写输入">
      {Array.from({ length: slots }).map((_, i) => {
        const st = statuses?.[i]?.status
        const shown = revealed && !statuses ? (expectedWords[i] ?? '') : (value[i] ?? '')
        const cls = ['spell-slot']
        if (st) cls.push(`is-${st}`)
        if (revealed && !statuses) cls.push('is-revealed')
        return (
          <span key={i} className="spell-slot-wrap">
            <input
              ref={el => { refs.current[i] = el }}
              type="text"
              className={cls.join(' ')}
              value={shown}
              readOnly={readOnly}
              disabled={readOnly}
              onChange={e => setAt(i, e.target.value)}
              onKeyDown={e => handleKeyDown(e, i)}
              onPaste={e => handlePaste(e, i)}
              onFocus={e => e.target.select()}
              style={{ width: `${Math.max(4, shown.length + 1)}ch` }}
              aria-invalid={st === 'wrong' || st === 'missing' ? true : undefined}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              aria-label={`第 ${i + 1} 个词`}
            />
            {(st === 'wrong' || st === 'missing') && expectedWords[i] && (
              <span className={`spell-slot-hint${st === 'missing' ? ' is-missing-hint' : ''}`}>
                {expectedWords[i]}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}
