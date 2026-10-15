/**
 * db/postgres-baseline.js — PostgreSQL 基线登记（postgres_baseline）的唯一实现（§13.1）。
 *
 * 事故背景（2026-10）：登记版本号被硬编码在多个文件里且彼此不一致
 * （db.js 写 38、scripts/import-team-db.mjs 写 37），而 schema_migrations.name 上有唯一索引
 * （sql/postgres/baseline.sql）。于是 openDb() 每次启动都以「新版本号 + 同名」插入，
 * 触发 23505 duplicate key → 业务进程启动即退 → PM2 重启 38 万次后被判 errored。
 *
 * 本模块确立的约定（改动前请先读这段）：
 *   1. 迁移的身份是 name，不是 version；version 只用于排序，不参与「是否已应用」的判断。
 *   2. 登记版本 = MAX(除基线自身外的 version) + 1 —— 按实际账本推导，天然不可能撞号，
 *      也不再需要任何地方硬编码版本号。
 *   3. 插入一律 ON CONFLICT DO NOTHING，并以「按 name 回读确认」收尾：
 *      多进程同时启动（PM2 一次拉起五个 PG 进程）也不会重复插入或撞主键。
 *   4. 幂等：已登记则原样返回，绝不重复插入、绝不改写既有 version。
 */

export const PG_BASELINE_NAME = 'postgres_baseline'
export const PG_BASELINE_CHECKSUM = 'baseline-v1'

/** 与 sql/postgres/baseline.sql 中的定义逐字一致。
 *  name 的 NOT NULL UNIQUE 是登记幂等性的前提，缺了它第 3 条约定形同虚设。 */
export const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     BIGINT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  );
`

const SELECT_BY_NAME = 'SELECT version FROM schema_migrations WHERE name = ?'
const SELECT_NEXT_VERSION = 'SELECT COALESCE(MAX(version), 0) AS maxv FROM schema_migrations WHERE name <> ?'
const INSERT_BASELINE =
  'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'

/** 并发抢同一号位时的重试上限；正常路径只跑一轮 */
const MAX_ATTEMPTS = 5

/**
 * 幂等登记 postgres_baseline。
 * @param {object} handle db/postgres-driver.mjs 句柄（dialect === 'postgres'）
 * @param {{ logger?: Console }} [options]
 * @returns {Promise<{ action: 'inserted' | 'exists', version: number }>}
 */
export async function ensurePostgresBaselineRegistered(handle, { logger = console } = {}) {
  if (!handle || handle.dialect !== 'postgres') {
    throw new Error('[pg-baseline] 需要 postgres 句柄（createPostgresHandle 的返回值）')
  }
  await handle.exec(SCHEMA_MIGRATIONS_DDL)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const existing = await handle.prepare(SELECT_BY_NAME).get(PG_BASELINE_NAME)
    if (existing) return { action: 'exists', version: Number(existing.version) }

    const row = await handle.prepare(SELECT_NEXT_VERSION).get(PG_BASELINE_NAME)
    const version = Number(row?.maxv ?? 0) + 1
    await handle
      .prepare(INSERT_BASELINE)
      .run(version, PG_BASELINE_NAME, PG_BASELINE_CHECKSUM, new Date().toISOString())

    // 并发窗口：别的进程可能刚抢走了同号位，也可能已经替我们登记过 —— 一律回读确认
    const after = await handle.prepare(SELECT_BY_NAME).get(PG_BASELINE_NAME)
    if (after) {
      return Number(after.version) === version
        ? { action: 'inserted', version }
        : { action: 'exists', version: Number(after.version) }
    }
    logger?.warn?.(`[pg-baseline] 第 ${attempt} 次登记号位被并发占用，重算版本号重试`)
  }
  throw new Error(
    `[pg-baseline] ${MAX_ATTEMPTS} 次尝试均与并发写入冲突，未能登记 ${PG_BASELINE_NAME}`
  )
}