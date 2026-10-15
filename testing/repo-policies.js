/**
 * testing/repo-policies.js — 按仓测试策略（多项目隔离）
 *
 * Policies are opt-in per configured repository profile.
 */
import { utcNow } from './ids.js'
import { getRepoPlatformProfile } from './repo-platform.js'

export async function getRepoTestPolicy(db, repoIdOrSlug) {
  if (!repoIdOrSlug) return defaultPolicy()
  let repoId = repoIdOrSlug
  try {
    const byId = await db.prepare('SELECT repo_id FROM repositories WHERE repo_id=?').get(repoIdOrSlug)
    if (byId) repoId = byId.repo_id
    else {
      const bySlug = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoIdOrSlug)
      if (bySlug) repoId = bySlug.repo_id
    }
  } catch {
    return defaultPolicy()
  }
  const row = await db.prepare('SELECT * FROM repo_test_policies WHERE repo_id=?').get(repoId)
  if (!row) return defaultPolicy()
  return {
    repoId: row.repo_id,
    enforceSpecContract: Boolean(row.enforce_spec_contract),
    enableSides: Boolean(row.enable_sides),
    runnerHint: row.runner_hint || null,
    reviewMode: row.review_mode || 'record',
  }
}

function defaultPolicy() {
  return {
    repoId: null,
    enforceSpecContract: false,
    enableSides: false,
    runnerHint: null,
    reviewMode: 'record',
  }
}

export async function upsertRepoTestPolicy(db, {
  repoId,
  enforceSpecContract = false,
  enableSides = false,
  runnerHint = null,
  reviewMode = null,
  now = utcNow(),
}) {
  await db.prepare(
    `INSERT INTO repo_test_policies(repo_id, enforce_spec_contract, enable_sides, runner_hint, review_mode, updated_at)
     VALUES (?, ?, ?, ?, COALESCE(?, 'record'), ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       enforce_spec_contract=excluded.enforce_spec_contract,
       enable_sides=excluded.enable_sides,
       runner_hint=excluded.runner_hint,
       review_mode=COALESCE(?, repo_test_policies.review_mode),
       updated_at=excluded.updated_at`
  ).run(repoId, enforceSpecContract ? 1 : 0, enableSides ? 1 : 0, runnerHint, reviewMode, now, reviewMode)
  return await getRepoTestPolicy(db, repoId)
}

/** Seed policy rows only for repositories with an explicit platform profile. */
export async function seedRepoTestPolicies(db, { now = utcNow() } = {}) {
  try {
    const rows = await db.prepare('SELECT repo_id, slug FROM repositories').all()
    for (const r of rows) {
      const profile = getRepoPlatformProfile(r.slug)
      if (!profile?.enabled) continue
      await upsertRepoTestPolicy(db, {
        repoId: r.repo_id,
        enforceSpecContract: true,
        enableSides: (profile.defaultSides || []).length > 1,
        runnerHint: profile.note || profile.casePrefix || r.slug,
        now,
      })
    }
  } catch {
    /* optional */
  }
}

/**
 * 已接入仓首次补默认 gate mode。
 * **绝不覆盖人工档位**：项目管理切到 legacy/observe/disabled 后重启也不会被拉回强制。
 * 仅在该仓尚无 gate_mode 行时写入 profile 指定的档位；默认 observe。
 */
export async function seedRepoGateModesEnforce(db, { now = utcNow() } = {}) {
  try {
    const rows = await db.prepare(
      `SELECT p.repo_id, r.slug FROM repo_test_policies p
       JOIN repositories r ON r.repo_id=p.repo_id`
    ).all()
    for (const r of rows) {
      const cur = await db.prepare('SELECT mode FROM repo_gate_modes WHERE repo_id=?').get(r.repo_id)
      if (!cur) {
        await db.prepare(
          'INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES (?, ?, ?)'
        ).run(r.repo_id, getRepoPlatformProfile(r.slug)?.gateMode || 'observe', now)
      }
      // 已有档位（含 legacy）一律尊重人工选择，启动迁移禁止改写
    }
  } catch {
    /* ignore */
  }
}
