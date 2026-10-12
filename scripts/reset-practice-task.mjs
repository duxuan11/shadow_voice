#!/usr/bin/env node
// 一次性清理某个练习任务的「已练」记录。
// 本次用途：speak 的题组从 45 条缩到 ≤25 条后，旧序号的含义已变，
// 不清的话打开自由表达就是"全部练过"（详见
// docs/superpowers/specs/2026-10-12-speak-prompts-quality-design.md §8）。
//
// 用法：
//   node --env-file-if-exists=.env scripts/reset-practice-task.mjs --task speak --dry
//   node --env-file-if-exists=.env scripts/reset-practice-task.mjs --task speak
//
// 库位置：SHADOW_VOICE_DB 或 <repo>/data/shadow_voice.db（server/db.cjs 决定）。
// 只动 practice_records.data 里的目标任务，shadow/cloze/translate 原样保留。
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * 纯函数：把 data JSON 文本里的 task 清成 []，其余键不动。
 * 解析失败 / 非对象 / 该任务非数组 / 已是空数组 → 原样返回且 changed=false（永不抛错）。
 * @param {string|null|undefined} json practice_records.data 的原始文本
 * @param {string} task 要清空的任务名
 * @returns {{json:string, changed:boolean}}
 */
export function clearTaskInData(json, task) {
  const original = { json: String(json ?? ''), changed: false }
  let data
  try {
    data = JSON.parse(json)
  } catch {
    return original
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return original
  if (!Array.isArray(data[task]) || data[task].length === 0) return original
  return { json: JSON.stringify({ ...data, [task]: [] }), changed: true }
}

async function main() {
  const args = process.argv.slice(2)
  const taskIdx = args.indexOf('--task')
  const task = taskIdx >= 0 ? args[taskIdx + 1] : 'speak'
  const dry = args.includes('--dry')
  if (!task) {
    console.error('[reset-practice-task] 缺少任务名，例如 --task speak')
    process.exit(2)
  }

  const { getDb, all, run } = require('../server/db.cjs')
  await getDb()
  const rows = all('SELECT id, data FROM practice_records')
  let changed = 0
  for (const row of rows) {
    const r = clearTaskInData(row.data, task)
    if (!r.changed) continue
    changed++
    if (!dry) {
      run("UPDATE practice_records SET data = ?, updated_at = datetime('now') WHERE id = ?", [r.json, row.id])
    }
  }
  console.log(`[reset-practice-task] 扫描 ${rows.length} 行，清理 ${changed} 行（task=${task}）${dry ? '（--dry，未写库）' : ''}`)
}

const invokedAsScript = process.argv[1] ? path.basename(process.argv[1]) === 'reset-practice-task.mjs' : false
if (invokedAsScript) {
  main().catch((err) => {
    console.error('[reset-practice-task] 异常：', err)
    process.exit(1)
  })
}
