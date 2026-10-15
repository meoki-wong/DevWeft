/**
 * testing/accounts.js — 项目环境登录账号（dev/qa，默认 qa）
 *
 * 安全模型：密码明文只写 secret-broker 独立库（不进 team.db、不进备份）；
 * team.db 的 repo_env_accounts 仅存 username + secret_ref。
 * 运行时 lane 通过 getRepoEnvAccountSecret 取明文（未来经 grant 一次性发放）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrokerDb, putSecret } from '../secret-broker/store.mjs'
import { utcNow } from './ids.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_BROKER_DB = path.join(__dirname, '..', 'data', 'secret-broker.db')

/** 环境固定 dev/qa 两个（表结构 env 为文本，未来扩展 uat/prod 无需迁移） */
export const ENV_ACCOUNT_ENVS = ['dev', 'qa']
/** 测试默认打 qa 环境 */
export const DEFAULT_TEST_ENV = 'qa'

function secretRefFor(slug, env) {
  return `repo-env-account:${slug}:${env}`
}

async function resolveRepo(db, repoIdOrSlug) {
  const row = await db
    .prepare('SELECT repo_id, slug FROM repositories WHERE repo_id=? OR slug=?')
    .get(repoIdOrSlug, repoIdOrSlug)
  if (!row) throw new Error(`UNRESOLVED_REPO: ${repoIdOrSlug}`)
  return row
}

/** 设置某项目某环境的登录账号；密码写入 secret-broker（upsert 覆盖旧值） */
export async function setRepoEnvAccount(db, { repoIdOrSlug, env, username, password, brokerDbPath = null }) {
  if (!ENV_ACCOUNT_ENVS.includes(env)) {
    throw new Error(`INVALID_ENV: ${env}（合法值：${ENV_ACCOUNT_ENVS.join(' / ')}）`)
  }
  if (!username || typeof username !== 'string') throw new Error('INVALID_SCHEMA: username 必填')
  if (!password || typeof password !== 'string') throw new Error('INVALID_SCHEMA: password 必填')
  const repo = await resolveRepo(db, repoIdOrSlug)
  const ref = secretRefFor(repo.slug, env)
  const bdb = openBrokerDb(brokerDbPath || DEFAULT_BROKER_DB)
  try {
    putSecret(bdb, ref, password)
  } finally {
    bdb.close()
  }
  await db.prepare(
    `INSERT INTO repo_env_accounts(repo_id, env, username, secret_ref, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, env) DO UPDATE SET
       username=excluded.username, secret_ref=excluded.secret_ref, updated_at=excluded.updated_at`
  ).run(repo.repo_id, env, username, ref, utcNow())
  return { repo: repo.slug, env, username, configured: true }
}

/** 清除某项目某环境账号：删 team.db 引用；broker 侧 secret 无 grant 引用时一并删 */
export async function clearRepoEnvAccount(db, { repoIdOrSlug, env }) {
  if (!ENV_ACCOUNT_ENVS.includes(env)) {
    throw new Error(`INVALID_ENV: ${env}（合法值：${ENV_ACCOUNT_ENVS.join(' / ')}）`)
  }
  const repo = await resolveRepo(db, repoIdOrSlug)
  const ref = secretRefFor(repo.slug, env)
  const gone = await db
    .prepare('DELETE FROM repo_env_accounts WHERE repo_id=? AND env=?')
    .run(repo.repo_id, env)
  try {
    const bdb = openBrokerDb(brokerDbPath || DEFAULT_BROKER_DB)
    try {
      await bdb.prepare('DELETE FROM secrets WHERE secret_ref=?').run(ref)
    } finally {
      bdb.close()
    }
  } catch {
    /* 有未过期的 grant 引用时保留 secret，无害 */
  }
  return { repo: repo.slug, env, configured: false, removed: gone.changes > 0 }
}

/** 看板用：只回 username/configured，永不回密码 */
export async function listRepoEnvAccounts(db, repoIdOrSlug) {
  let repo = null
  try {
    repo = await resolveRepo(db, repoIdOrSlug)
  } catch {
    return Object.fromEntries(ENV_ACCOUNT_ENVS.map((e) => [e, { configured: false }]))
  }
  const rows = await db
    .prepare('SELECT env, username, updated_at FROM repo_env_accounts WHERE repo_id=?')
    .all(repo.repo_id)
  const byEnv = Object.fromEntries(
    ENV_ACCOUNT_ENVS.map((e) => {
      const r = rows.find((x) => x.env === e)
      return [e, { configured: Boolean(r), username: r?.username || null, updated_at: r?.updated_at || null }]
    })
  )
  return byEnv
}

/** lane 运行时用：取明文（不对外暴露 HTTP） */
export async function getRepoEnvAccountSecret(db, repoIdOrSlug, env, brokerDbPath = null) {
  if (!ENV_ACCOUNT_ENVS.includes(env)) {
    throw new Error(`INVALID_ENV: ${env}（合法值：${ENV_ACCOUNT_ENVS.join(' / ')}）`)
  }
  const repo = await resolveRepo(db, repoIdOrSlug)
  const row = await db
    .prepare('SELECT username, secret_ref FROM repo_env_accounts WHERE repo_id=? AND env=?')
    .get(repo.repo_id, env)
  if (!row) return null
  const bdb = openBrokerDb(brokerDbPath || DEFAULT_BROKER_DB)
  try {
    const secret = await bdb.prepare('SELECT plaintext FROM secrets WHERE secret_ref=?').get(row.secret_ref)
    if (!secret) return null
    return { username: row.username, password: secret.plaintext }
  } finally {
    bdb.close()
  }
}

/** 项目默认测试环境：未设置回落 qa（integration lane 执行时以此为准） */
export async function getDefaultTestEnv(db, repoIdOrSlug) {
  try {
    const repo = await resolveRepo(db, repoIdOrSlug)
    const row = await db
      .prepare('SELECT default_test_env FROM repo_env_settings WHERE repo_id=?')
      .get(repo.repo_id)
    if (row && ENV_ACCOUNT_ENVS.includes(row.default_test_env)) return row.default_test_env
  } catch { /* 仓未登记/表不存在：回落默认 */ }
  return DEFAULT_TEST_ENV
}

export async function setDefaultTestEnv(db, repoIdOrSlug, env) {
  if (!ENV_ACCOUNT_ENVS.includes(env)) {
    throw new Error(`INVALID_ENV: ${env}（合法值：${ENV_ACCOUNT_ENVS.join(' / ')}）`)
  }
  const repo = await resolveRepo(db, repoIdOrSlug)
  await db.prepare(
    `INSERT INTO repo_env_settings(repo_id, default_test_env, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       default_test_env=excluded.default_test_env, updated_at=excluded.updated_at`
  ).run(repo.repo_id, env, utcNow())
  return { repo: repo.slug, defaultTestEnv: env }
}
