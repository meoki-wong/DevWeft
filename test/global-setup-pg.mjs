/**
 * test/global-setup-pg.mjs — PG 方言测试库初始化（vitest globalSetup，所有 worker 前执行一次）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export default async function globalSetup() {
  if (process.env.AWP_DB_DIALECT !== 'postgres') return
  const adminUrl = process.env.AWP_PG_URL || 'postgresql://awp@127.0.0.1:5433/awp'
  const base = adminUrl.replace(/\/[^/]+$/, '')
  const testUrl = `${base}/awp_test`

  const pg = await import('pg')
  const adminPool = new pg.default.Pool({ connectionString: `${base}/postgres` })
  await adminPool.query('DROP DATABASE IF EXISTS awp_test')
  await adminPool.query('CREATE DATABASE awp_test')
  await adminPool.end()
  console.log('[global-setup-pg] awp_test 已重建')

  // 用原生 pg.Pool 跑 baseline（持连接执行，确保事务提交）
  const pool = new pg.default.Pool({ connectionString: testUrl })
  const client = await pool.connect()
  try {
    let baselineSql = fs.readFileSync(path.join(root, 'sql', 'postgres', 'baseline.sql'), 'utf8')
    baselineSql = baselineSql.replace(/^\s*BEGIN;\s*$/gm, '').replace(/^\s*COMMIT;\s*$/gm, '')
    await client.query(baselineSql)
    const r = await client.query(`SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema='public'`)
    console.log(`[global-setup-pg] baseline 完成，表数=${r.rows[0].c}`)
  } finally {
    client.release()
    await pool.end()
  }

  const urlFile = path.join(root, 'data', '.testdb-tmp', 'pg-test-url.txt')
  fs.mkdirSync(path.dirname(urlFile), { recursive: true })
  fs.writeFileSync(urlFile, testUrl)
  console.log(`[global-setup-pg] → ${testUrl}`)
}
