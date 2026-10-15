/**
 * backup-db.mjs — 数据库备份（方案 §2.8/§13.1）
 * sqlite 方言：better-sqlite3 backup API / checkpoint+copy 降级（WAL 安全）
 * postgres 方言（AWP_DB_DIALECT=postgres）：调用 pg_dump
 *
 * 优先使用 better-sqlite3 backup API（在线、一致性、不停服）。
 * 不可用时降级：wal_checkpoint(TRUNCATE) + 三文件复制 + integrity_check。
 *
 * 用法：
 *   node scripts/backup-db.mjs [--db data/team.db] [--out data/backups] [--keep 14]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCb)
const DIALECT = process.env.AWP_DB_DIALECT === 'postgres' ? 'postgres' : 'sqlite'
const Database = DIALECT === 'sqlite' ? (await import('better-sqlite3')).default : null

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

const DB_PATH = path.resolve(arg('db', path.join(ROOT, 'data', 'team.db')))
const OUT_DIR = path.resolve(arg('out', path.join(ROOT, 'data', 'backups')))
const KEEP = Number(arg('keep', '14'))

if (!fs.existsSync(DB_PATH)) {
  console.error(`[backup] 未找到 ${DB_PATH}`)
  process.exit(0)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const destPath = path.join(OUT_DIR, `team.db.${ts}.bak`)

function report(obj) {
  console.log(JSON.stringify(obj, null, 2))
}

async function backupPostgres() {
  // postgres 方言：pg_dump（§2.8 替换 db.backup()/PRAGMA integrity_check）
  const url = process.env.AWP_PG_URL || arg('pg-url', null)
  if (!url) {
    throw new Error('postgres 方言需要 AWP_PG_URL 或 --pg-url')
  }
  const destPath = path.join(OUT_DIR, `team-pg.${ts}.sql`)
  await execFile('pg_dump', ['--no-owner', '--no-privileges', '--file', destPath, url], {
    env: { ...process.env, PGPASSWORD: process.env.AWP_PG_PASSWORD || '' },
    timeout: 600_000,
  })
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
    throw new Error('pg_dump 未产出备份文件')
  }
  return { mode: 'pg_dump', backupPath: destPath, integrityCheck: 'pg_dump exit 0' }
}

async function backupOnline() {
  const src = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    // better-sqlite3: db.backup(destination) → Promise
    await src.backup(destPath)
  } finally {
    src.close()
  }
  const dest = new Database(destPath, { readonly: true, fileMustExist: true })
  const integrity = dest.prepare('PRAGMA integrity_check').get()
  const pageCount = dest.prepare('PRAGMA page_count').get()
  dest.close()
  return {
    mode: 'sqlite-backup-api',
    backupPath: destPath,
    integrityCheck: integrity?.integrity_check || integrity || 'unknown',
    pageCount: pageCount?.page_count ?? null,
  }
}

function backupCheckpointFallback() {
  const src = new Database(DB_PATH)
  let checkpoint = null
  try {
    checkpoint = src.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    src.close()
  }
  fs.copyFileSync(DB_PATH, destPath)
  const wal = `${DB_PATH}-wal`
  const shm = `${DB_PATH}-shm`
  if (fs.existsSync(wal)) fs.copyFileSync(wal, `${destPath}-wal`)
  if (fs.existsSync(shm)) fs.copyFileSync(shm, `${destPath}-shm`)
  const dest = new Database(destPath, { readonly: true, fileMustExist: true })
  const integrity = dest.prepare('PRAGMA integrity_check').get()
  dest.close()
  return {
    mode: 'checkpoint+copy3',
    backupPath: destPath,
    checkpoint,
    integrityCheck: integrity?.integrity_check || integrity || 'unknown',
    walCopied: fs.existsSync(wal),
    shmCopied: fs.existsSync(shm),
  }
}

function prune() {
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => (f.startsWith('team.db.') && f.endsWith('.bak')) || (f.startsWith('team-pg.') && f.endsWith('.sql')))
    .sort()
    .reverse()
  const excess = files.slice(KEEP)
  for (const f of excess) {
    fs.rmSync(path.join(OUT_DIR, f), { force: true })
    console.log(`[backup] 删除旧备份: ${f}`)
  }
  return { kept: Math.min(files.length, KEEP), deleted: excess.length }
}

const started = Date.now()
let result
if (DIALECT === 'postgres') {
  try {
    result = await backupPostgres()
  } catch (e) {
    console.error(`[backup] pg_dump 失败: ${e.message}`)
    process.exit(1)
  }
} else {
  try {
    result = await backupOnline()
  } catch (e) {
    console.warn(`[backup] online backup API 失败，降级 checkpoint+copy: ${e.message}`)
    try {
      result = backupCheckpointFallback()
    } catch (e2) {
      console.error(`[backup] 备份失败: ${e2.message}`)
      process.exit(1)
    }
  }
}

const stat = fs.statSync(destPath)
prune()
report({
  ...result,
  bytes: stat.size,
  durationMs: Date.now() - started,
  recoverableTimestamp: ts,
})
console.log(`[backup] 完成 → ${destPath}`)
