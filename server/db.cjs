const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')

const DB_PATH = path.join(__dirname, '..', 'data', 'vidDict.db')

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
}

// sql.js doesn't auto-save — call this after writes
function saveDb() {
  if (!db) return
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
