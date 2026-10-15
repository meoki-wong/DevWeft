/**
 * 独立 artifact scanner（§12）：无凭据、不执行内容，只校验 ZIP 结构与文本泄密并落 scan_state。
 * 用法：node scanner/index.mjs [--once] [--db <path>] [--blob-root <path>] [--interval <ms>]
 */
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createBlobStore } from '../testing/blobs.js'
import { openDb, DB_DIALECT } from '../db.js'
import { installSqliteTx } from '../db/sqlite-tx.js'
// 注意：不要在模块顶层 import testing/artifacts.js
// artifacts → leases → test-specs → db.js，db.js import 即跑迁移；
// 迁移失败会让整个 scanner 在 main() 之前就挂掉，PM2 表现为启动即退 → 无限重启。
// scanArtifact 改为 main() 内动态 import，失败可被捕获并 process.exit(1) 走明确错误日志。

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const entryIsSelf = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
// PM2 fork 模式下 argv[1]=ProcessContainerFork.js，须与 server.js 同款兜住
const launchedByPm2 = process.env.pm_id != null && process.env.pm_exec_path != null
if (entryIsSelf || launchedByPm2) {
  main().catch((err) => {
    process.stderr.write(`scanner: fatal ${err && err.message ? err.message : err}\n`)
    process.exit(1)
  })
}

async function main() {
  const dbPath = argValue('--db', join(repoRoot, 'data', 'team.db'))
  const blobRoot = argValue('--blob-root', join(repoRoot, 'data', 'blobs'))
  const intervalMs = Number(argValue('--interval', process.env.AWP_SCANNER_INTERVAL_MS || '10000'))
  const once = process.argv.includes('--once')

  if (DB_DIALECT === 'sqlite' && !existsSync(dbPath)) {
    process.stderr.write(`scanner: 数据库不存在 ${dbPath}\n`)
    process.exit(2)
  }
  try {
    const { scanArtifact } = await import('../testing/artifacts.js')
    // 方言化（方案 §7）：sqlite 用自身连接（--db 可指副本）；postgres 走 openDb() 的 pg 句柄
    const db = DB_DIALECT === 'postgres' ? await openDb() : new Database(dbPath)
    if (DB_DIALECT === 'sqlite') {
      installSqliteTx(Database)
      db.pragma('foreign_keys = ON')
    }
    const blobs = createBlobStore(blobRoot)

    async function scanOnce() {
      const rows = await db.prepare(
        `SELECT a.artifact_id
         FROM artifacts a
         JOIN run_attempts ra ON ra.run_id=a.run_id AND ra.attempt=a.attempt
         WHERE a.scan_state='pending'
         ORDER BY a.created_at ASC LIMIT 20`
      ).all()
      for (const { artifact_id: artifactId } of rows) {
        try {
          const report = await scanArtifact(db, blobs, artifactId)
          process.stdout.write(`scanner ${artifactId} verdict=${report.verdict} violations=${JSON.stringify(report.violations)}\n`)
        } catch (err) {
          process.stderr.write(`scanner ${artifactId} error=${err.message}\n`)
          try {
            await db.prepare(`UPDATE artifacts SET scan_state='error', scanner_report_sha256=NULL WHERE artifact_id=? AND scan_state='pending'`)
              .run(artifactId)
          } catch { /* ignore */ }
        }
      }
      return rows.length
    }

    await scanOnce()
    if (!once) {
      // 禁止 unref：否则无其它 handle 时 Node 立刻退出，PM2 会变成「启动→打 init→退出」死循环
      setInterval(() => scanOnce().catch((err) => process.stderr.write(`scanner: tick ${err.message}\n`)), intervalMs)
      process.stdout.write(`scanner: watching ${dbPath} every ${intervalMs}ms\n`)
    }
  } catch (err) {
    process.stderr.write(`scanner: fatal ${err && err.message ? err.message : err}\n`)
    process.exit(1)
  }
}
