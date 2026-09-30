// 听写 / 听练共用的逐词比对引擎（纯函数，零依赖）。
// 把用户答案与正确原文按空格切词后逐位比较，区分：
//   correct 正确 / wrong 错误 / missing 遗漏 / extra 多余
// 该模块从 DictationPage.jsx 抽出，行为与抽取前完全一致。

export function normalizeText(text) {
  return String(text ?? '').replace(/[^\w\s'-]/g, '').replace(/\s+/g, ' ').trim()
}

export function tokenize(text) {
  const normalized = normalizeText(text)
  return normalized ? normalized.split(' ') : []
}

export function checkSpelling(userInput, correctText) {
  const userWords = tokenize(userInput)
  const correctWords = tokenize(correctText)
  const maxLen = Math.max(userWords.length, correctWords.length)
  const results = []

  for (let i = 0; i < maxLen; i++) {
    const uw = userWords[i]
    const cw = correctWords[i]

    if (uw === undefined) {
      results.push({ type: 'missing', expected: cw })
    } else if (cw === undefined) {
      results.push({ type: 'extra', user: uw })
    } else if (uw.toLowerCase() === cw.toLowerCase()) {
      results.push({ type: 'correct', word: uw })
    } else {
      results.push({ type: 'wrong', user: uw, expected: cw })
    }
  }
  return results
}

export function isAllCorrect(spellResults) {
  return spellResults.every(r => r.type === 'correct')
}
