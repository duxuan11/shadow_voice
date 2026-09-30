// 生词听练「逐词槽位」纯函数：拆分期望答案、逐槽判定、粘贴分配。
// 零依赖；复用 spellCheck 的 normalizeText/tokenize（只读，不改该文件）。
import { normalizeText, tokenize } from './spellCheck.js'

export function splitToSlots(expected) {
  return tokenize(expected)
}

export function slotCountFor(expected) {
  return Math.max(1, splitToSlots(expected).length)
}

export function compareSlots(values, expectedWords) {
  const list = Array.isArray(values) ? values : []
  const expected = Array.isArray(expectedWords) ? expectedWords : []
  const n = Math.max(list.length, expected.length)
  const out = []
  for (let i = 0; i < n; i++) {
    const user = String(list[i] ?? '').trim()
    const exp = String(expected[i] ?? '')
    if (!user) out.push({ status: 'missing', expected: exp, user: '' })
    else if (normalizeText(user).toLowerCase() === normalizeText(exp).toLowerCase()) {
      out.push({ status: 'correct', expected: exp, user })
    } else {
      out.push({ status: 'wrong', expected: exp, user })
    }
  }
  return out
}

export function distributePaste(text, count, startIndex = 0, base = []) {
  const n = Math.max(1, Number(count) || 1)
  const out = Array.from({ length: n }, (_, k) => String(base[k] ?? ''))
  const start = Math.min(Math.max(0, Number(startIndex) || 0), n - 1)
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  let i = start
  for (const w of words) {
    if (i >= n - 1) {
      out[n - 1] = out[n - 1] ? `${out[n - 1]} ${w}` : w
      i = n
    } else {
      out[i] = w
      i += 1
    }
  }
  return out
}

export function joinSlots(values) {
  return (Array.isArray(values) ? values : []).map(v => String(v ?? '').trim()).join(' ').trim()
}

export function slotsAllCorrect(statuses) {
  return Array.isArray(statuses) && statuses.length > 0 && statuses.every(s => s.status === 'correct')
}
