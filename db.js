/**
 * db.js — 数据库初始化 + Schema（多租户 repo 隔离）
 * 方言：AWP_DB_DIALECT=postgres → PostgreSQL（openDb() 异步连接，§13.1）；缺省 sqlite（WAL）。
 */

const DB_DIALECT = process.env.AWP_DB_DIALECT === 'postgres' ? 'postgres' : 'sqlite'
export { DB_DIALECT }

// ─── SQLite 方言（缺省，行为与第 1–6 节完全一致）──────────────────────
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { runTestingMigrations, seedDefaultTenantRepos } from './testing/migrate.js'
import { nextId } from './db/id-sequence.js'
import { installSqliteTx } from './db/sqlite-tx.js'
import { ensureLinkSchema } from './db/link-schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
// 测试/CI 用 AWP_DB_PATH 指向一次性副本，避免单测直接写真实 team.db（生产不设此变量）
const DB_PATH = process.env.AWP_DB_PATH
  ? path.resolve(process.env.AWP_DB_PATH)
  : path.join(DATA_DIR, 'team.db')

// 确保数据目录存在
fs.mkdirSync(DATA_DIR, { recursive: true })

// 初始化数据库（WAL 模式）；postgres 方言下不在 import 阶段连接任何库（§13.1）
const db = DB_DIALECT === 'sqlite' ? new Database(DB_PATH) : null
if (db) {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 15000') // 并发写等待 15 秒（vitest 并行 + v18 起迁移写窗口变大，5s 会偶发 locked）
}

/**
 * 初始化全部表结构 + FTS5 + 触发器
 */
export function initDB() {
  if (DB_DIALECT !== 'sqlite') return // postgres:结构由 baseline.sql 负责（§13.1）
  // ─── 经验库 ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id          TEXT PRIMARY KEY,
      repo        TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT DEFAULT 'auto',
      status      TEXT DEFAULT 'pending',
      author      TEXT NOT NULL,
      module      TEXT,
      task_id     TEXT,
      rule_ref    TEXT,
      tags        TEXT DEFAULT '[]',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_exp_repo ON experiences(repo);
    CREATE INDEX IF NOT EXISTS idx_exp_status ON experiences(status);
    CREATE INDEX IF NOT EXISTS idx_exp_module ON experiences(module);
  `)

  // ─── FTS5 全文索引（trigram 支持中文子串 / keep-alive 连字符词）──────────
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
      content, module, tags, repo,
      tokenize='trigram',
    );

    CREATE TRIGGER IF NOT EXISTS exp_ai AFTER INSERT ON experiences BEGIN
      INSERT INTO experiences_fts(rowid, content, module, tags, repo)
      VALUES (new.rowid, new.content, COALESCE(new.module, ''), new.tags, new.repo);
    END;

    CREATE TRIGGER IF NOT EXISTS exp_ad AFTER DELETE ON experiences BEGIN
      DELETE FROM experiences_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS exp_au AFTER UPDATE ON experiences BEGIN
      DELETE FROM experiences_fts WHERE rowid = old.rowid;
      INSERT INTO experiences_fts(rowid, content, module, tags, repo)
      VALUES (new.rowid, new.content, COALESCE(new.module, ''), new.tags, new.repo);
    END;
  `)

  // ─── 任务库 ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id     TEXT NOT NULL,
      repo        TEXT NOT NULL,
      requirement TEXT,
      type        TEXT,
      phase       TEXT,
      completed   TEXT DEFAULT '[]',
      pending     TEXT DEFAULT '[]',
      decisions   TEXT DEFAULT '[]',
      author      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      closed_at   TEXT,
      PRIMARY KEY (repo, task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo);
    CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);
  `)

  // ─── 任务版本时间线（四层框架 L3：artifact_version）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      repo        TEXT NOT NULL,
      phase       TEXT,
      snapshot    TEXT NOT NULL,
      author      TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tv ON task_versions(repo, task_id);
  `)

  // ─── 验证统计 ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS verify_reports (
      id          TEXT PRIMARY KEY,
      repo        TEXT NOT NULL,
      level       TEXT,
      side        TEXT,
      file        TEXT,
      pass        INTEGER,
      errors      INTEGER,
      detail      TEXT,
      author      TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_verify_repo ON verify_reports(repo);
    CREATE INDEX IF NOT EXISTS idx_verify_level ON verify_reports(level);
  `)


  // ─── 知识库（规范文档）──────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo        TEXT NOT NULL,
      name        TEXT NOT NULL,
      category    TEXT,
      content     TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      updated_by  TEXT,
      UNIQUE(repo, name)
    );

    CREATE INDEX IF NOT EXISTS idx_docs_repo ON docs(repo);
    CREATE INDEX IF NOT EXISTS idx_docs_category ON docs(category);
  `)

  // ─── 知识库 FTS5 全文索引 ──────────────────────────
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      content, name, category, repo,
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS doc_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, content, name, category, repo)
      VALUES (new.rowid, new.content, new.name, COALESCE(new.category, ''), new.repo);
    END;

    CREATE TRIGGER IF NOT EXISTS doc_ad AFTER DELETE ON docs BEGIN
      DELETE FROM docs_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS doc_au AFTER UPDATE ON docs BEGIN
      DELETE FROM docs_fts WHERE rowid = old.rowid;
      INSERT INTO docs_fts(rowid, content, name, category, repo)
      VALUES (new.rowid, new.content, new.name, COALESCE(new.category, ''), new.repo);
    END;
  `)

  // ─── 知识库版本时间线（规范上云保险丝：update_doc 写入前存快照，可一键回滚）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs_versions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      repo           TEXT NOT NULL,
      name           TEXT NOT NULL,
      version        INTEGER NOT NULL DEFAULT 1,
      content_before TEXT,
      content_after  TEXT,
      category_before TEXT,
      category_after  TEXT,
      author         TEXT,
      created_at     TEXT NOT NULL,
      UNIQUE(repo, name, version)
    );

    CREATE INDEX IF NOT EXISTS idx_dv ON docs_versions(repo, name);
  `)

  // ─── 规则单一真源（RULES_MANIFEST：MCP instructions 硬规则摘要）──
  // 由 harness/bootstrap-instructions.js 读入 InitializeResult.instructions；
  // 规则由项目 owner 选择性复制到 client configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules_manifest (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT NOT NULL,
      rule_count INTEGER NOT NULL DEFAULT 0,
      author     TEXT,
      created_at TEXT NOT NULL
    );
  `)
  // 首次启动注入默认清单（可用 update_doc(name='RULES_MANIFEST', ...) 覆盖）
  const manifestExists = db.prepare("SELECT COUNT(*) as c FROM docs WHERE repo = 'shared' AND name = 'RULES_MANIFEST'").get()
  if (!manifestExists.c) {
    const defaultManifest = [
      '1. 卡片圆角以设计稿为准，不强制统一值（原统一圆角约束已取消）',
      '2. 品牌红 #fc3f41（小写）',
      '3. 顶部导航栏不要实现（AppNav 全局处理）',
      '4. 空状态用 <Empty> 组件 + !loading 守卫',
      '5. 滚动容器高度 calc(100vh - @navTitleHeight - 36px)',
      '6. 开发写 px（postcss-pxtorem 自动转 rem，rootValue 37.5）',
      '7. 新代码用 <script setup> + defineComponent({ name })',
      '8. 遇到 bug 先调用 MCP distill_query(关键词) 查团队经验库',
      '9. Harness：新任务 harness_start → 阶段推进 harness_advance（禁止 task_state 改 phase）',
      '10. AC 纪律：M/L 任务进入 EXECUTE 前必须交 AC 验收清单（L: PLAN→EXECUTE；M: CLASSIFY→EXECUTE），写码后冻结不可改',
      '11. 考试失败先看修复包分类：考卷问题改 spec（不计迭代）；业务问题修代码（必须 distill dev 经验）',
      '12. distill 按类型带 category：开发踩坑=dev（人工审核）；测试考卷=test（免审直生效）',
      '13. 云端测试按「脏工作区快照」送测：改完直接 awp_test_run，无需 git commit/push，禁止要求用户提交代码（改动存盘即被快照）',
    ].join('\n')
    db.prepare(
      `INSERT INTO docs (repo, name, category, content, updated_at, updated_by)
       VALUES ('shared', 'RULES_MANIFEST', 'rules', ?, ?, 'system')`
    ).run(defaultManifest, new Date().toISOString())
    db.prepare(
      `INSERT INTO rules_manifest (content, rule_count, author, created_at)
       VALUES (?, ?, 'system', ?)`
    ).run(defaultManifest, 9, new Date().toISOString())
  }

  // WAL 下多进程（PM2 服务 + vitest 并行 worker）可能同时跑迁移：BEGIN IMMEDIATE
  // 遇他人持写锁/锁升级时 SQLITE_BUSY_SNAPSHOT 不吃 busy_timeout，需外层重试。
  // 迁移幂等（IF NOT EXISTS / user_version 守卫），整体重跑安全。
  let migrationErr = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      runTestingMigrations(db)
      migrationErr = null
      break
    } catch (err) {
      if (err && err.code === 'SQLITE_BUSY') {
        migrationErr = err
        const until = Date.now() + 500 * (attempt + 1)
        while (Date.now() < until) { /* 同步退避：模块加载期，可接受 */ }
        continue
      }
      throw err
    }
  }
  if (migrationErr) throw migrationErr
  // 生产启动路径的默认租户种子（迁移函数不再自动 seed——迁移只管 schema）
  seedDefaultTenantRepos(db)
  // 链路网关方案 §3：三张链路表 + 主链路种子（sqlite 同步执行，initDB 为同步上下文）
  ensureLinkSchema(db)
  console.log('[db] SQLite 初始化完成（WAL 模式，FTS5 已启用）')
}

// 模块加载时即初始化表结构（仅 sqlite 方言；postgres 由 openDb() + 基线负责）
if (DB_DIALECT === 'sqlite') initDB()

/**
 * db.tx — 方言无关的异步安全事务（方案 §13.1「事务写成 BEGIN、按顺序 await、COMMIT」）。
 *
 * - postgres：由 db/postgres-driver.mjs 提供同名实现（client BEGIN → await fn(tx) → COMMIT）
 * - sqlite：BEGIN IMMEDIATE 后执行 fn(db)。fn 内的 await 只让出微任务、不让出事件循环，
 *   其他宏任务（I/O/定时器）无法在事务开启期间插入，原子性与 better-sqlite3 原生事务一致；
 *   已处于事务中（嵌套）时直接执行，不开新事务
 *
 * 挂在 Database.prototype 上：测试自建的 better-sqlite3 实例（memdb）同样可用。
 * 新代码一律用 db.tx；better-sqlite3 原生 db.transaction 仅保留给历史迁移路径（同步语义）。
 */
if (DB_DIALECT === 'sqlite') {
  installSqliteTx(Database)
}

/**
 * 方案 §13.1：db.js 提供 await openDb()；禁止在 import 的同步阶段连接 PostgreSQL。
 * - sqlite 方言：返回既有同步单例（行为不变）
 * - postgres 方言：连接 PG 并返回 better-sqlite3 形状的异步句柄（db/postgres-driver.mjs）；
 *   结构来自 sql/postgres/baseline.sql（postgres_baseline 登记），不重放任何 SQLite 迁移
 * - 基线登记口径见 db/postgres-baseline.js（postgres_baseline 的 name/版本/幂等策略）
 */
let pgOpenPromise = null
let pgHandle = null
export async function openDb() {
  if (DB_DIALECT === 'sqlite') return db
  if (!pgOpenPromise) {
    pgOpenPromise = (async () => {
      const { createPostgresHandle } = await import('./db/postgres-driver.mjs')
      const { ensurePostgresBaselineRegistered } = await import('./db/postgres-baseline.js')
      const handle = await createPostgresHandle({ connectionString: process.env.AWP_PG_URL || null })
      pgHandle = handle
      // 基线登记（§13.1）：身份=name、版本=max(非基线)+1、ON CONFLICT 幂等。
      // 口径统一在 db/postgres-baseline.js，切勿在本文件另写版本号 —— 历史上正是
      // 「db.js 写 38 / import 脚本写 37」的错配撞上 name 唯一索引，导致进程启动即退。
      await ensurePostgresBaselineRegistered(handle)
      // 链路网关方案 §3：postgres 连接成功、baseline 登记后建三张链路表 + 主链路种子
      await ensureLinkSchema(handle)
      // baseline 之后代码里新增的列，通过 PG patchups 分支自动补齐（对齐 SQLite 的 v37+ 迁移）
      // 幂等：applyVersionedMigrationAsync 按 checksum 跳过；ADD COLUMN IF NOT EXISTS 双保险
      await runTestingMigrations(handle)
      return handle
    })().catch((err) => {
      // 失败不得缓存：否则本进程内后续所有 openDb() 都会拿到同一个已 rejected 的 Promise。
      // 清空后下一次调用可重新尝试（PG 计划任务重启、临时网络抖动后自愈）。
      pgOpenPromise = null
      pgHandle = null
      throw err
    })
  }
  return pgOpenPromise
}

/**
 * 生成当日经验 id：exp-YYYYMMDD-NNN
 * v28 起走 id_sequences（事务 + RETURNING），不再 COUNT(*)+1。
 */
export async function nextExpId() {
  return nextId(DB_DIALECT === 'sqlite' ? db : pgHandle, 'exp')
}

/**
 * 生成当日验证报告 id：rep-YYYYMMDD-NNN
 * v28 起走 id_sequences，删史不回退、并发不重复。
 */
export async function nextRepId() {
  return nextId(DB_DIALECT === 'sqlite' ? db : pgHandle, 'rep')
}

// 直接运行 db.js 时打印数据量（仅 sqlite 方言）
if (DB_DIALECT === 'sqlite' && process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = {
    experiences: db.prepare('SELECT COUNT(*) as c FROM experiences').get().c,
    tasks: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
    docs: db.prepare('SELECT COUNT(*) as c FROM docs').get().c,
    verify_reports: db.prepare('SELECT COUNT(*) as c FROM verify_reports').get().c,
  }
  console.log('[db] 当前数据量:', counts)
}

// sqlite：默认导出同步单例；postgres：代理转发到 pgHandle（openDb() 之后才可用，提前使用给出明确报错）
export default DB_DIALECT === 'sqlite'
  ? db
  : new Proxy(
      {},
      {
        get(_t, prop) {
          // dialect 是只读元信息，openDb() 前也可读（isPostgres 判定用）
          if (prop === 'dialect') return 'postgres'
          if (!pgHandle) {
            throw new Error(
              `[db] AWP_DB_DIALECT=postgres 下禁止在 openDb() 之前同步使用 db.${String(prop)}；` +
                '请在 start() 中先 await openDb()（§13.1）'
            )
          }
          const v = pgHandle[prop]
          return typeof v === 'function' ? v.bind(pgHandle) : v
        },
      }
    )
