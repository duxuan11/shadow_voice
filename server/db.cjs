const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')

const DB_PATH = process.env.SHADOW_VOICE_DB || path.join(__dirname, '..', 'data', 'shadow_voice.db')

let db = null

async function getDb() {
  if (db) return db

  const SQL = await initSqlJs()

  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }

  initSchema()
  return db
}

function initSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS dictation_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id   TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, video_id)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS vocabulary (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    word       TEXT NOT NULL,
    video_id   TEXT,
    video_title TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, word)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS video_progress (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id     TEXT NOT NULL,
    current_time REAL DEFAULT 0,
    duration     REAL DEFAULT 0,
    completed    INTEGER DEFAULT 0,
    updated_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, video_id)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS conversation_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    topics_json TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    review_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    score REAL,
    issues_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS watch_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id   TEXT NOT NULL,
    watched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, video_id)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS ai_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model TEXT,
    result TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(video_id, prompt_version)
  )`)

  // 旧库迁移：已有 conversation_sessions 表缺少 review_json 列（CREATE IF NOT EXISTS 不会补列）
  ensureColumn('conversation_sessions', 'review_json', 'TEXT')
  // 新增：场景档案列（视频 → AI Role Play）
  ensureColumn('conversation_sessions', 'scene_json', 'TEXT')
}

// sql.js 没有 ALTER TABLE 幂等语法 —— 检查列是否存在，缺失才补
function ensureColumn(table, column, type) {
  try {
    const res = db.exec(`PRAGMA table_info(${table})`)
    const cols = (res[0]?.values || []).map(r => r[1])
    if (!cols.includes(column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  } catch (err) {
    console.error(`[db] 迁移 ${table}.${column} 失败:`, err.message)
  }
}

// sql.js doesn't auto-save — call this after writes
function saveDb() {
  if (!db) return
  // Ensure the data directory exists
  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const data = db.export()
  const buffer = Buffer.from(data)
  fs.writeFileSync(DB_PATH, buffer)
}

// Helper: run a statement and return lastInsertRowid
function run(sql, params = []) {
  db.run(sql, params)
  const result = db.exec('SELECT last_insert_rowid() as id')
  const id = result[0]?.values[0]?.[0]
  saveDb()
  return { lastInsertRowid: id }
}

// Helper: get a single row
function get(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  if (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    stmt.free()
    const row = {}
    cols.forEach((c, i) => { row[c] = vals[i] })
    return row
  }
  stmt.free()
  return undefined
}

// Helper: get all rows
function all(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const cols = stmt.getColumnNames()
  const rows = []
  while (stmt.step()) {
    const vals = stmt.get()
    const row = {}
    cols.forEach((c, i) => { row[c] = vals[i] })
    rows.push(row)
  }
  stmt.free()
  return rows
}

module.exports = { getDb, run, get, all, saveDb }
