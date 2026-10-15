/**
 * import-team-db.test.mjs — 方案第 7 节：导入脚本对账（§13.3）
 *
 * 使用小型 SQLite fixture（真实迁移产生的全量 schema + 少量种子行），
 * 以 PGlite 作为目标跑 scripts/import-team-db.mjs，断言：
 *   - 退出码 0；行数对账一致；tasks 的 (tenant_id, task_id) 集合一致
 *   - postgres_baseline 已登记（身份=name；版本按账本推导，不硬编码，见 db/postgres-baseline.js）
 * 不断言生产 team.db（§13.3）。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function buildFixture(dir) {
  // 1) 全量迁移：独立子进程 import db.js（AWP_DB_PATH 指向 fixture）
  const dbPath = path.join(dir, 'fixture.db')
  const bootstrap = path.join(dir, 'bootstrap.mjs')
  fs.writeFileSync(
    bootstrap,
    [
      `process.env.AWP_DB_PATH = ${JSON.stringify(dbPath)}`,
      `const { default: db } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'db.js')).href)})`,
      `const { ensureRepository } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'testing', 'migrate.js')).href)})`,
      `const rid = ensureRepository(db, 'fixture-repo', null)`,
      `db.prepare(\`INSERT INTO tasks (task_id, repo, tenant_id, requirement, type, phase, author, created_at, updated_at)
         VALUES ('T-fixture-1', 'fixture-repo', ?, 'fixture', 'FIX', 'receive', 'a', 't', 't')\`).run(rid)`,
      `db.prepare(\`INSERT INTO tasks (task_id, repo, tenant_id, requirement, type, phase, author, created_at, updated_at)
         VALUES ('T-fixture-2', 'fixture-repo', ?, 'fixture2', 'FIX', 'done', 'a', 't', 't')\`).run(rid)`,
      `db.prepare(\`INSERT INTO docs (repo, tenant_id, name, category, content, updated_at)
         VALUES ('fixture-repo', ?, 'fixture-doc', 'rules', 'fixture 内容 border-radius', 't')\`).run(rid)`,
      `console.log('fixture ready')`,
    ].join('\n')
  )
  const boot = spawnSync(process.execPath, [bootstrap], { encoding: 'utf8' })
  if (boot.status !== 0) throw new Error('fixture 构建失败: ' + boot.stderr)

  // 2) 种子行数快照
  const db = new Database(dbPath, { readonly: true })
  const counts = {
    tasks: (await db.prepare('SELECT COUNT(*) c FROM tasks').get()).c,
    docs: (await db.prepare('SELECT COUNT(*) c FROM docs').get()).c,
    task_versions: (await db.prepare('SELECT COUNT(*) c FROM task_versions').get()).c,
  }
  db.close()
  return { dbPath, counts }
}

describe('import-team-db（方案 §13.1/§13.3）', () => {
  it('fixture 导入 PGlite：退出码 0、行数一致、postgres_baseline 已登记', async () => {
    // 脚本要能解析项目 node_modules（@electric-sql/pglite），临时目录建在项目内
    const dir = fs.mkdtempSync(path.join(root, 'data', '.testdb-tmp', 'awp-import-'))
    const { dbPath, counts } = await buildFixture(dir)
    const pgDir = path.join(dir, 'pgdata')
    fs.mkdirSync(pgDir, { recursive: true })

    const script = path.join(root, 'scripts', 'import-team-db.mjs')
    const run = spawnSync(process.execPath, [script, '--db', dbPath, '--pglite', pgDir], {
      encoding: 'utf8',
      cwd: root,
    })
    expect(run.status, (run.stderr || '') + (run.stdout || '')).toBe(0)

    // 目标库核验：行数 + 集合 + postgres_baseline
    const verify = path.join(dir, 'verify.mjs')
    fs.writeFileSync(
      verify,
      [
        `import { PGlite } from '@electric-sql/pglite'`,
        `import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'`,
        `const pg = new PGlite(${JSON.stringify(pgDir)}, { extensions: { pg_trgm } })`,
        `const tasks = (await pg.query('SELECT COUNT(*) c FROM tasks')).rows[0].c`,
        `const docs = (await pg.query('SELECT COUNT(*) c FROM docs')).rows[0].c`,
        `const tv = (await pg.query('SELECT COUNT(*) c FROM task_versions')).rows[0].c`,
        `const set = (await pg.query('SELECT tenant_id, task_id FROM tasks ORDER BY task_id')).rows.map(r => r.task_id)`,
        `const baseline = (await pg.query("SELECT version FROM schema_migrations WHERE name = 'postgres_baseline'")).rows`,
        `const maxOther = (await pg.query("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations WHERE name <> 'postgres_baseline'")).rows[0].v`,
        `const pass = (await pg.query("SELECT data_type FROM information_schema.columns WHERE table_name='verify_reports' AND column_name='pass'")).rows[0].data_type`,
        `console.log(JSON.stringify({ tasks, docs, tv, set, baseline, maxOther, pass }))`,
        `await pg.close()`,
      ].join('\n')
    )
    const out = spawnSync(process.execPath, [verify], { encoding: 'utf8', cwd: root })
    expect(out.status, (out.stderr || '') + (out.stdout || '')).toBe(0)
    const result = JSON.parse(out.stdout)
    expect(result.tasks).toBe(counts.tasks)
    expect(result.docs).toBe(counts.docs)
    expect(result.tv).toBe(counts.task_versions)
    expect(result.set).toEqual(['T-fixture-1', 'T-fixture-2'])
    expect(result.baseline.length).toBe(1)
    // 基线版本按账本推导，必须大于所有非基线行（fixture 的 sqlite 已含 v37 mutation_verdict）
    expect(Number(result.baseline[0].version)).toBeGreaterThan(Number(result.maxOther))
    expect(result.pass).toBe('smallint')

    fs.rmSync(dir, { recursive: true, force: true })
  }, 60000)
})
