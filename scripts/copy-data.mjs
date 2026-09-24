// 构建收尾：把数据目录里的索引 JSON（consolidated.json / meta.json）复制到
// dist/data，供纯静态部署使用。数据目录来自 DATA_DIR（默认 <root>/data），
// 与 dev / server 保持一致。
//
// 用法：node --env-file-if-exists=.env scripts/copy-data.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { resolveDataDir } from '../server/lib/dataDir.cjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const DATA_FILES = ['consolidated.json', 'meta.json']

/**
 * 复制数据索引文件到目标目录；存在的才复制，目标目录不存在会自动创建。
 * @returns {string[]} 实际复制的文件名
 */
export function copyDataFiles(dataDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const copied = []
  for (const name of DATA_FILES) {
    const src = path.join(dataDir, name)
    if (!fs.existsSync(src)) continue
    fs.copyFileSync(src, path.join(outDir, name))
    copied.push(name)
  }
  return copied
}

function main() {
  const dataDir = resolveDataDir(process.env.DATA_DIR, ROOT)
  const outDir = path.join(ROOT, 'dist', 'data')
  const copied = copyDataFiles(dataDir, outDir)
  console.log(`[copy-data] ${dataDir} -> ${outDir} (${copied.length ? copied.join(', ') : '无文件可复制'})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
