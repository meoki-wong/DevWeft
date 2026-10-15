/**
 * testing/test-specs.js — 测试资产库数据访问层（schema v9 test_specs）
 *
 * 设计（feature-key 模式）：
 *  - 测试脚本由 AI coding 通过 MCP 工具提交，集中存服务端（不入业务仓库）
 *  - feature_key（业务功能键）是查询/组织核心索引；version 为同 key 修订历史
 *  - 内容 sha256 寻址存 data/test-specs/（同 blobs 内容寻址结构，独立目录）
 *  - 三道防线：①开发时先查后改 ②审核插槽（v19，可插拔审核者） ③fail_streak 连续失败标 orphan
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import db from '../db.js'
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'
import { validateE2eSpecContent } from './spec-contract.js'
import { reviewSpec, getReviewMode } from './reviewers.js'
import { aiShadowVerdict } from './reviewers-ai.js'
import { scoreAssertionStrength } from '../harness/testing-gate.js'
import { getRepoTestPolicy } from './repo-policies.js'
import { createBlobStore } from './blobs.js'
import { createBlobStoreForEnv } from './blob-store-env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPEC_ROOT = path.join(__dirname, '..', 'data', 'test-specs')
// 新内容统一落 blob 存储（data/blobs，内容寻址同构）；仅备用机经 HTTP 上传到主机。
// 主机侧运行时（loadLockedSpecs/specsForGateInject）读本机盘：先旧目录（历史卷兼容），
// 再 data/blobs（新写入与备用机远程上传的落点）——两个目录都是内容寻址，sha 即真相。
const BLOB_STORE = createBlobStore(path.join(__dirname, '..', 'data', 'blobs'))
const FEATURE_KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const SPEC_TYPES = ['smoke', 'e2e', 'unit']
const STATUSES = ['draft', 'reviewed', 'active', 'archived', 'orphan-candidate']
// Side metadata selects a configured smoke lane; null leaves the asset available to all lanes.

function specContentPath(sha256) {
  return path.join(SPEC_ROOT, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
}

/**
 * 写考卷内容（env 感知）：主机 → 本地 data/blobs；备用机 → HTTP 上传主机 blob 服务。
 * 写本机盘在备用机上 = 主机运行时 SPEC_CONTENT_MISSING（10-09 三轮 HEARTBEAT_LOST 的根因）。
 * 异步：远程上传需要 await；返回内容 sha256。
 */
async function writeSpecContent(content) {
  const sha256 = createHash('sha256').update(content).digest('hex')
  const store = await createBlobStoreForEnv(db)
  if (store.isRemote) {
    const prep = await store.prepare({ kind: 'test-spec', sha256, size: Buffer.byteLength(content, 'utf8') })
    if (prep.uploadId) await store.writeUpload(prep.uploadId, Buffer.from(content, 'utf8'))
    // 本地缓存副本：提交节点本机立刻可读（去重分支/强度棘轮/返回 getTestSpec 都读本机盘）。
    // 远程上传已落主机 blob 服务，这里再写一份 data/blobs，内容寻址同 sha 双写无冲突。
    // 不写的话：备用机提交 → 返回时 getTestSpec 读不到 → 把已成功的提交炸成 SPEC_CONTENT_MISSING（10-09 实录）。
    const local = BLOB_STORE.contentPath(sha256)
    fs.mkdirSync(path.dirname(local), { recursive: true })
    if (!fs.existsSync(local)) fs.writeFileSync(local, content, 'utf8')
    return sha256
  }
  // 主机：写进 blob 存储（data/blobs）；旧 SPEC_ROOT 不再写（读侧双目录兼容）。
  const dest = store.contentPath(sha256)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, content, 'utf8')
  return sha256
}

function readSpecContent(sha256) {
  // 先旧目录（历史卷），再 data/blobs（新落点）；两处都不在才报缺。
  const legacy = specContentPath(sha256)
  if (fs.existsSync(legacy)) return fs.readFileSync(legacy, 'utf8')
  const inBlobs = BLOB_STORE.contentPath(sha256)
  if (fs.existsSync(inBlobs)) return fs.readFileSync(inBlobs, 'utf8')
  throw new ApiError('SPEC_CONTENT_MISSING', { detail: `内容 ${String(sha256).slice(0, 12)}… 在本机 test-specs 与 blobs 均不存在（若由备用机提交，内容需已上传到主机 blob 存储）` })
}

/**
 * repo 标识归一：MCP 工具/看板传 slug（demo-app），runner 传 repo_id（UUID）。
 * 统一解析成 repo_id，避免 slug 写入后与 runner 的 UUID 查询错配（资产永不执行的已知坑）。
 * 未登记的标识原样返回（保持历史行为，查询落空由调用方处理）。
 */
export async function normalizeRepoId(repoIdOrSlug) {
  if (!repoIdOrSlug) return repoIdOrSlug
  const byId = await db.prepare('SELECT repo_id FROM repositories WHERE repo_id=?').get(repoIdOrSlug)
  if (byId) return byId.repo_id
  const bySlug = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoIdOrSlug)
  return bySlug ? bySlug.repo_id : repoIdOrSlug
}

/**
 * feature_key 收敛：小写连字符；拒绝与既有 active/archived key 仅差连字符/大小写的近义重复。
 * Example: near-duplicate feature keys are rejected unless they describe distinct behavior.
 */
export function normalizeFeatureKey(key) {
  return String(key || '')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function compactFeatureKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export async function findNearDuplicateFeatureKey(repoId, featureKey, { excludeKey = null } = {}) {
  const target = compactFeatureKey(featureKey)
  if (!target) return null
  const rows = await db
    .prepare(
      `SELECT DISTINCT feature_key FROM test_specs WHERE repo_id = ? AND feature_key != ?`
    )
    .all(repoId, excludeKey || featureKey)
  for (const r of rows) {
    if (compactFeatureKey(r.feature_key) === target) return r.feature_key
    // 前缀高度重叠（>=12 且一方包含另一方）视为近义
    const other = compactFeatureKey(r.feature_key)
    if (target.length >= 12 && other.length >= 12 && (target.includes(other) || other.includes(target))) {
      return r.feature_key
    }
  }
  return null
}

/** 提交（创建或修订）一个测试资产。同 feature_key 已有版本时自动 version+1，旧版转 archived。
 *  pages：考卷覆盖的页面/目录（跨页面回归归因用）；acceptanceRefs：对应任务 AC 的 id 列表。 */
export async function submitTestSpec({
  repoId: rawRepoId,
  featureKey,
  featureTitle,
  demandRef,
  author,
  specType,
  codeCommitOid,
  content,
  side = null,
  pages = null,
  acceptanceRefs = null,
  taskId = null,
}) {
  const repoId = await normalizeRepoId(rawRepoId)
  if (!repoId) throw new ApiError('INVALID_SCHEMA')
  const normalizedKey = normalizeFeatureKey(featureKey)
  if (!FEATURE_KEY_RE.test(normalizedKey || '')) throw new ApiError('INVALID_FEATURE_KEY')
  if (normalizedKey !== String(featureKey || '')) {
    // Normalize separators and case so equivalent feature keys cannot drift apart.
    featureKey = normalizedKey
  }
  const near = await findNearDuplicateFeatureKey(repoId, featureKey)
  if (near && near !== featureKey) {
    // 近义重复：复用已有 key 修订，勿再开新 key
    throw new ApiError('INVALID_FEATURE_KEY')
  }
  if (!author) throw new ApiError('INVALID_SCHEMA')
  if (!SPEC_TYPES.includes(specType)) throw new ApiError('INVALID_SCHEMA')
  if (typeof content !== 'string' || !content.trim()) throw new ApiError('INVALID_SCHEMA')
  if (codeCommitOid && !/^[0-9a-f]{7,64}$/.test(codeCommitOid)) throw new ApiError('INVALID_SCHEMA')
  if (side != null && (typeof side !== 'string' || !side.trim())) throw new ApiError('INVALID_SCHEMA')
  if (pages != null && (!Array.isArray(pages) || pages.length > 20 || pages.some((p) => typeof p !== 'string' || !p.trim() || p.length > 120))) {
    throw new ApiError('INVALID_SCHEMA: pages 须为路径字符串数组（≤20 项）')
  }
  if (acceptanceRefs != null && (!Array.isArray(acceptanceRefs) || acceptanceRefs.length > 50 || acceptanceRefs.some((a) => typeof a !== 'string' || !a.trim()))) {
    throw new ApiError('INVALID_SCHEMA: acceptanceRefs 须为 AC id 字符串数组')
  }

  // 平台 E2E 契约：仅对开启 enforce_spec_contract 的仓（当前 project）校验；
  // 其他接入项目默认关闭，避免 project 专用 baseURL/side 规则干扰
  const policy = await getRepoTestPolicy(db, repoId)
  if (policy.enforceSpecContract && (specType === 'e2e' || specType === 'smoke')) {
    const verdict = validateE2eSpecContent(content, { side, specType, enforceContract: true })
    if (!verdict.ok) {
      throw new ApiError('INVALID_SPEC_CONTRACT', { detail: verdict.errors.join('；') })
    }
  } else if (policy.enforceSpecContract && specType === 'unit') {
    const verdict = validateE2eSpecContent(content, { side: null, specType: 'unit' })
    if (!verdict.ok) throw new ApiError('INVALID_SPEC_CONTRACT')
  }

  const existing = await db
    .prepare(
      `SELECT spec_id, version, review_status, blob_sha256, spec_type, side, pages_json, acceptance_refs_json
       FROM test_specs
       WHERE repo_id = ? AND feature_key = ? ORDER BY version DESC LIMIT 1`
    )
    .get(repoId, featureKey)

  // 熔断闸门：连败关小黑屋的考卷禁止继续刷版本（先读错题本修复，人工/看板解封）
  if (existing && existing.review_status === 'orphan-candidate') {
    throw new ApiError('SPEC_ORPHANED', {
      detail:
        `${featureKey} 连续失败 ${'≥'}3 次已进入 orphan-candidate。请先 awp_test_spec_get 读全文与失败记录，` +
        '修复内容后联系管理员在看板解封，或改用新的 featureKey。',
    })
  }

  const blobSha = await writeSpecContent(content)
  // 元数据（pages / AC / side / type）也是执行语义的一部分：内容没变但元数据变了，
  // 必须产生新版本，否则「提交时冻结的清单」永远停在旧语义上
  const metaChanged = Boolean(existing) && (
    String(existing.spec_type || '') !== String(specType || '')
    || String(existing.side || '') !== String(side || '')
    || String(existing.pages_json || '') !== (pages ? JSON.stringify(pages.map((pg) => String(pg).trim().replace(/\\/g, '/')).filter(Boolean)) : '')
    || String(existing.acceptance_refs_json || '') !== (acceptanceRefs ? JSON.stringify(acceptanceRefs.map((a) => String(a).trim()).filter(Boolean)) : '')
  )
  if (existing && existing.blob_sha256 === blobSha && !metaChanged) {
    // 内容与执行元数据都未变：返回现有最新版，不产生冗余版本。
    // 幂等命中且本机无原文副本（旧版本可能提交自身一节点）时降级返回元数据——
    // 内容就在本次入参里，绝不能把幂等命中炸成失败。
    try {
      return await getTestSpec({ repoId, featureKey })
    } catch (e) {
      if (e.code !== 'SPEC_CONTENT_MISSING') throw e
      const row = await db.prepare(
        `SELECT * FROM test_specs WHERE repo_id = ? AND feature_key = ? ORDER BY version DESC LIMIT 1`
      ).get(repoId, featureKey)
      return { ...row, content: null, contentMissing: true }
    }
  }

  // 断言强度棘轮：新版本分数不得低于旧版本（基线只升不降）
  if (existing) {
    try {
      const oldContent = readSpecContent(existing.blob_sha256)
      const oldScore = scoreAssertionStrength(oldContent)
      const newScore = scoreAssertionStrength(content)
      if (newScore < oldScore) {
        throw new ApiError('SPEC_STRENGTH_REGRESSION', {
          detail: `断言强度 ${oldScore} → ${newScore}：基线只升不降。增强断言（对接口契约/数据状态），而不是简化。`,
        })
      }
    } catch (e) {
      if (e.code === 'SPEC_STRENGTH_REGRESSION') throw e
      /* 读旧内容失败不阻断（旧内容可能提交自身一节点，本机无副本） */
    }
  }

  const now = utcNow()
  const specId = uuidv7()
  const version = existing ? existing.version + 1 : 1
  // unit 资产 entry 带 .unit 中缀：runner 注入时按 spec_type 分流目录，文件名仅作人读区分
  const entry = specType === 'unit' ? `${featureKey}.unit.spec.mjs` : `${featureKey}.spec.mjs`

  // ── 审核插槽（v19）：由档位决定审核链，结论落到 review_status + review_* 四列 ──
  // 默认档位 record：跑确定性审核、记录结论，但不阻塞生效 → 行为等价于改动前
  // （契约硬校验已在前段 throw，链内 auto:contract 此时只做归因记录）
  const reviewMode = getReviewMode(policy)
  let verdict = reviewSpec({
    spec: { repoId, featureKey, specType, side, content },
    policy,
    mode: reviewMode,
  })
  // AI 审卷员影子模式（2026-09-26）：record 档位下 AI 结论只追加进 review_notes，
  // 不改变生效行为；分歧率数据积累后切 ai 档成为正式结论（见 reviewers-ai.js 头注释）
  if (reviewMode === 'record') {
    const shadow = await aiShadowVerdict({ spec: { repoId, featureKey, specType, side, content } })
    if (shadow && shadow.decision !== 'abstain') {
      verdict = {
        ...verdict,
        notes: `${verdict.notes || ''} | [ai-shadow] ${shadow.decision}: ${shadow.notes}`.slice(0, 500),
      }
    }
  }

  const insert = async (tx) => {
    // 任务私有考卷：带 taskId 提交 → 先 draft（不进公共 active 池），
    // 本任务门禁可跑；全绿后 promoteTaskDraftSpecsToActive 再晋升。
    // 未带 taskId 且审核通过 → 保持原 active 语义（公共池）。
    const reviewStatus = taskId ? 'draft' : verdict.reviewStatus
    await tx.prepare(
      `INSERT INTO test_specs
         (spec_id, repo_id, feature_key, feature_title, demand_ref, author, spec_type, entry,
          blob_sha256, code_commit_oid, version, review_status,
          reviewed_by, reviewed_at, review_decision, review_notes,
          side, acceptance_refs_json, pages_json,
          created_at, updated_at, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      specId, repoId, featureKey, featureTitle || featureKey,
      taskId || demandRef || null,
      author, specType, entry, blobSha, codeCommitOid || null,
      version, reviewStatus,
      verdict.by, now, verdict.decision, verdict.notes || null,
      side || null,
      acceptanceRefs ? JSON.stringify(acceptanceRefs.map((a) => String(a).trim()).filter(Boolean)) : null,
      pages ? JSON.stringify(pages.map((pg) => String(pg).trim().replace(/\\/g, '/')).filter(Boolean)) : null,
      now, now,
      'task'
    )
    if (existing && ['draft', 'active', 'reviewed'].includes(existing.review_status)) {
      await tx.prepare(
        `UPDATE test_specs SET review_status = 'archived', updated_at = ? WHERE spec_id = ?`
      ).run(now, existing.spec_id)
    }
  }
  await db.tx(insert)
  // 版本已落库：返回时读不到原文（旧节点副本缺失）绝不能把已成功的提交炸成失败——
  // 降级返回元数据 + contentMissing 标记，提交方仍可凭入参内容与回执 version 续作。
  try {
    return await getTestSpec({ repoId, featureKey })
  } catch (e) {
    if (e.code !== 'SPEC_CONTENT_MISSING') throw e
    const row = await db.prepare(
      `SELECT * FROM test_specs WHERE repo_id = ? AND feature_key = ? ORDER BY version DESC LIMIT 1`
    ).get(repoId, featureKey)
    return { ...row, content: null, contentMissing: true }
  }
}

/** 改动影响面预检（2026-09-26）：与 scoped 注入同款 pages∩改动 匹配，反向提示受波及的 active 卷 */
export async function previewImpactedSpecs({ repoId: rawRepoId, changedFiles = [], conn = db }) {
  const repoId = await normalizeRepoId(rawRepoId)
  const files = (Array.isArray(changedFiles) ? changedFiles : []).map((f) => String(f || '')).filter(Boolean)
  if (!repoId || !files.length) return []
  let rows = []
  try {
    rows = await conn.prepare(
      `SELECT feature_key, feature_title, spec_type, side, scope, pages_json, demand_ref, review_status, last_result, fail_streak, version
       FROM test_specs WHERE repo_id=? AND review_status='active'`
    ).all(repoId) || []
  } catch { rows = [] }
  const affected = filterSpecsForSpecInject(rows, { changedFiles: files, mode: 'scoped', taskId: '__impact_preview__' })
  return affected.map((s) => ({
    featureKey: s.feature_key,
    version: s.version,
    title: s.feature_title || '',
    specType: s.spec_type,
    side: s.side || null,
    scope: String(s.scope || 'task'),
    lastResult: s.last_result ?? null,
    failStreak: Number(s.fail_streak || 0),
  }))
}

/**
 * 门禁可执行考卷：
 * - scope=regression 且 active：公共回归，始终可跑
 * - review_status=draft 且 demand_ref=taskId：本任务私有草稿
 * - 其余 active：公共 task 卷（再经 filterSpecsForSpecInject 按 pages 收）
 */
export async function specsForGateInject(rawRepoId, taskId = null) {
  const repoId = await normalizeRepoId(rawRepoId)
  const rows = await db
    .prepare(
      `SELECT spec_id, feature_key, spec_type, entry, blob_sha256, version, side,
              pages_json, demand_ref, scope, review_status
       FROM test_specs
       WHERE repo_id = ?
         AND (
           (review_status = 'active' AND (scope IS NULL OR scope IN ('task','regression')))
           OR (review_status = 'draft' AND ? IS NOT NULL AND demand_ref = ?)
         )
       ORDER BY feature_key`
    )
    .all(repoId, taskId, taskId)
  return rows.map((r) => ({ ...r, content: readSpecContent(r.blob_sha256) }))
}

/** 任务正式门禁全绿：把该任务 draft 考卷晋升为 active（默认仍 scope=task）。 */
export async function promoteTaskDraftSpecsToActive(rawRepoId, taskId, { now = utcNow() } = {}) {
  if (!taskId) return { promoted: 0 }
  const repoId = await normalizeRepoId(rawRepoId)
  const r = await db.prepare(
    `UPDATE test_specs SET review_status='active', updated_at=?
     WHERE repo_id=? AND review_status='draft' AND demand_ref=?`
  ).run(now, repoId, taskId)
  return { promoted: r.changes }
}

/** 任务终态清理：未晋升的 draft 保留（可人工归档）；ABORTED 可选归档。 */
export async function archiveTaskDraftSpecs(rawRepoId, taskId, { now = utcNow() } = {}) {
  if (!taskId) return { archived: 0 }
  const repoId = await normalizeRepoId(rawRepoId)
  const r = await db.prepare(
    `UPDATE test_specs SET review_status='archived', updated_at=?
     WHERE repo_id=? AND review_status='draft' AND demand_ref=?`
  ).run(now, repoId, taskId)
  return { archived: r.changes }
}

/** 查询单个资产（默认取最新版本；可指定 version）。附带内容。 */
export async function getTestSpec({ repoId: rawRepoId, featureKey, version = null }) {
  const repoId = await normalizeRepoId(rawRepoId)
  const row = version
    ? await db
        .prepare('SELECT * FROM test_specs WHERE repo_id = ? AND feature_key = ? AND version = ?')
        .get(repoId, featureKey, version)
    : await db
        .prepare('SELECT * FROM test_specs WHERE repo_id = ? AND feature_key = ? ORDER BY version DESC LIMIT 1')
        .get(repoId, featureKey)
  if (!row) throw new ApiError('NOT_FOUND')
  return { ...row, content: readSpecContent(row.blob_sha256) }
}

/** 资产清单（按项目过滤，可按作者/需求/状态细分）。不含内容，附摘要行数。 */
export async function listTestSpecs({ repoId: rawRepoId, author = null, demandRef = null, reviewStatus = null, featureHint = null } = {}) {
  const repoId = rawRepoId ? await normalizeRepoId(rawRepoId) : rawRepoId
  const conds = []
  const params = []
  if (repoId) { conds.push('repo_id = ?'); params.push(repoId) }
  if (author) { conds.push('author = ?'); params.push(author) }
  if (demandRef) { conds.push('demand_ref = ?'); params.push(demandRef) }
  if (reviewStatus) { conds.push('review_status = ?'); params.push(reviewStatus) }
  if (featureHint) { conds.push('feature_key LIKE ?'); params.push(`%${featureHint}%`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = await db
    .prepare(
      `SELECT spec_id, repo_id, feature_key, feature_title, demand_ref, author, spec_type,
              version, review_status, last_result, fail_streak, code_commit_oid, side,
              created_at, updated_at, scope
       FROM test_specs ${where} ORDER BY feature_key, version DESC`
    )
    .all(...params)
  // 同 feature_key 只展示最新版本，历史版本挂 history
  const byFeature = new Map()
  for (const row of rows) {
    if (!byFeature.has(row.feature_key)) byFeature.set(row.feature_key, { ...row, history: [] })
    else byFeature.get(row.feature_key).history.push({ version: row.version, review_status: row.review_status, updated_at: row.updated_at })
  }
  return [...byFeature.values()]
}

/** 评审流转：状态人工调整入口（orphan 恢复 / 降级 draft 暂存 / 归档）。审核人落 review_* 列。 */
export async function transitionTestSpec({ repoId: rawRepoId, featureKey, version, reviewStatus, reviewer = null, notes = null }) {
  const repoId = await normalizeRepoId(rawRepoId)
  if (!STATUSES.includes(reviewStatus)) throw new ApiError('INVALID_SCHEMA')
  const row = await db
    .prepare('SELECT spec_id, review_status FROM test_specs WHERE repo_id=? AND feature_key=? AND version=?')
    .get(repoId, featureKey, version)
  if (!row) throw new ApiError('NOT_FOUND')

  const now = utcNow()
  // 状态 → 审核结论的映射（reviewed = 已审但暂不生效）
  const decision =
    reviewStatus === 'active' ? 'approved' :
    reviewStatus === 'draft' ? 'pending' :
    reviewStatus === 'orphan-candidate' ? 'rejected' :
    null

  await db.prepare(
    `UPDATE test_specs
     SET review_status   = ?,
         reviewed_by     = COALESCE(?, reviewed_by),
         reviewed_at     = ?,
         review_decision = COALESCE(?, review_decision),
         review_notes    = COALESCE(?, review_notes),
         updated_at      = ?
     WHERE spec_id = ?`
  ).run(reviewStatus, reviewer, now, decision, notes, now, row.spec_id)

  return await getTestSpec({ repoId, featureKey, version })
}

/** 记录执行结果（M 组执行后回写），维护 last_result / fail_streak。 */
export async function recordSpecResult({ repoId: rawRepoId, featureKey, passed }) {
  const repoId = await normalizeRepoId(rawRepoId)
  const now = utcNow()
  const streak = passed ? 0 : 1
  await db.prepare(
    `UPDATE test_specs
     SET last_result = ?, fail_streak = CASE WHEN ? = 1 THEN fail_streak + 1 ELSE 0 END, updated_at = ?
     WHERE repo_id = ? AND feature_key = ? AND review_status = 'active'`
  ).run(passed ? 'passed' : 'failed', passed ? 0 : 1, now, repoId, featureKey)
  // 防线三：连续失败 >=3 自动标 orphan-candidate（暂停执行，进待评审）
  await db.prepare(
    `UPDATE test_specs SET review_status = 'orphan-candidate', updated_at = ?
     WHERE repo_id = ? AND feature_key = ? AND review_status = 'active' AND fail_streak >= 3`
  ).run(now, repoId, featureKey)
}

/** 执行注入：项目下全部 active 资产（M 组触发时由 runner 拉取执行）。 */
export async function activeSpecsForRepo(rawRepoId) {
  const repoId = await normalizeRepoId(rawRepoId)
  const rows = await db
    .prepare(
      `SELECT spec_id, feature_key, spec_type, entry, blob_sha256, version, side,
              pages_json, demand_ref, scope
       FROM test_specs WHERE repo_id = ? AND review_status = 'active' ORDER BY feature_key`
    )
    .all(repoId)
  return rows.map((r) => ({ ...r, content: readSpecContent(r.blob_sha256) }))
}

/** 同上但不读内容（提交时冻结清单用：清单只存身份，内容由内容寻址库保管） */
export async function activeSpecRowsForRepo(rawRepoId) {
  const repoId = await normalizeRepoId(rawRepoId)
  return await db
    .prepare(
      `SELECT spec_id, feature_key, spec_type, entry, blob_sha256, version, side,
              pages_json, demand_ref, scope
       FROM test_specs WHERE repo_id = ? AND review_status = 'active' ORDER BY feature_key`
    )
    .all(repoId)
}

/**
 * 按冻结清单取内容（内容寻址 + 逐条 sha256 校验）。
 * 缺内容或摘要不符 → 抛错（禁止静默降级成"这卷不跑了"）。
 * 返回行与 activeSpecsForRepo 同形（snake_case），执行侧注入逻辑无需分支。
 */
export function loadLockedSpecs(lock) {
  const entries = Array.isArray(lock?.specs) ? lock.specs : []
  return entries.map((e) => {
    const content = readSpecContent(e.blobSha256)
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== e.blobSha256) {
      throw new ApiError('SPEC_CONTENT_MISSING', { detail: `${e.featureKey} 内容摘要不符（清单 ${e.blobSha256.slice(0, 12)}… ≠ 实际 ${actual.slice(0, 12)}…）` })
    }
    return {
      spec_id: e.specId,
      feature_key: e.featureKey,
      spec_type: e.specType,
      entry: e.entry,
      blob_sha256: e.blobSha256,
      version: e.version,
      side: e.side || null,
      scope: e.scope || 'task',
      pages_json: null,
      demand_ref: null,
      content,
    }
  })
}

/**
 * 门禁注入范围过滤（信号质量）。
 * mode（按项目可配，默认 scoped）：
 *  - scoped：regression 始终跑；有 pages 且与改动有交集才跑 task 卷
 *  - all：该项目全部 active 卷（旧行为，全量）
 *  - regression_only：只跑 scope=regression
 * 全局 platform_settings.inject_all_e2e=on 时强制 all（运维逃生阀）。
 */
export const E2E_INJECT_MODES = Object.freeze(['scoped', 'all', 'regression_only'])

/**
 * 读取顺序（方案 §9.1）：
 *  1. 平台键 inject_all_e2e = on → 'all'（运维逃生阀，保持）
 *  2. repo_runtime_settings 中该 repo_id 的 e2e_inject_mode
 *  3. 旧键 e2e_inject_mode:<slug>（值合法时写入新表并返回——一次性搬迁）
 *  4. 否则 'scoped'
 */
export async function getE2eInjectMode(db, repoSlug) {
  try {
    if (await db.prepare(`SELECT value, value_json FROM platform_settings WHERE key='inject_all_e2e'`).get()) {
      const row = await db.prepare(`SELECT value, value_json FROM platform_settings WHERE key='inject_all_e2e'`).get()
      const v = row.value ?? (row.value_json ? (() => {
        try { const p = JSON.parse(row.value_json); return typeof p === 'string' ? p : String(p) } catch { return row.value_json }
      })() : null)
      if (v === 'on') return 'all'
    }
  } catch { /* settings 未建 */ }
  const slug = String(repoSlug || '').toLowerCase()
  try {
    const row = await db
      .prepare(
        `SELECT s.value_json FROM repo_runtime_settings s
         JOIN repositories r ON r.repo_id = s.repo_id
         WHERE r.slug = ? AND s.key = 'e2e_inject_mode'`
      )
      .get(slug)
    if (row) {
      try {
        const parsed = JSON.parse(row.value_json)
        const v = typeof parsed === 'string' ? parsed : String(parsed)
        if (E2E_INJECT_MODES.includes(v)) return v
      } catch { /* 非法 JSON 视为未设置 */ }
    }
  } catch { /* 新表未建（v35 前的库） */ }
  // 旧键：读到合法值 → 搬迁进 repo_runtime_settings（不再写回 platform_settings）
  try {
    const legacy = await db
      .prepare(`SELECT value FROM platform_settings WHERE key=?`)
      .get(`e2e_inject_mode:${slug}`)
    if (legacy && E2E_INJECT_MODES.includes(legacy.value)) {
      await setE2eInjectMode(db, slug, legacy.value)
      return legacy.value
    }
  } catch { /* ignore */ }
  return 'scoped'
}

/**
 * 写入 repo_runtime_settings（方案决定：不再写 platform_settings 的 e2e_inject_mode:*）。
 * repo 未登记时抛 REPO_NOT_FOUND（新表 FK 要求 repo_id 有效）。
 */
export async function setE2eInjectMode(db, repoSlug, mode) {
  if (!E2E_INJECT_MODES.includes(mode)) {
    throw new Error(`INVALID_E2E_INJECT_MODE: ${mode}（合法：${E2E_INJECT_MODES.join(' / ')}）`)
  }
  const slug = String(repoSlug || '').toLowerCase()
  const repoRow = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(slug)
  if (!repoRow) {
    throw new Error(`REPO_NOT_FOUND: ${slug}（repo_runtime_settings 以 repo_id 为键；请先接入租户仓）`)
  }
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO repo_runtime_settings(repo_id, key, value_json, updated_at) VALUES (?, 'e2e_inject_mode', ?, ?)
     ON CONFLICT(repo_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
  ).run(repoRow.repo_id, JSON.stringify(mode), now)
  return { repo: slug, mode }
}

export function filterSpecsForSpecInject(specs, {
  changedFiles = null,
  mode = 'scoped',
  injectAllE2e = false,
  taskId = null,
} = {}) {
  if (!Array.isArray(specs) || !specs.length) return []
  const m = injectAllE2e ? 'all' : (E2E_INJECT_MODES.includes(mode) ? mode : 'scoped')
  if (m === 'all') return specs
  const out = []
  for (const s of specs) {
    // 本任务草稿卷：始终注入（任务私有，与 pages 无关）
    if (taskId && String(s.demand_ref || '') === String(taskId) && s.review_status === 'draft') {
      out.push(s)
      continue
    }
    if (String(s.scope || 'task') === 'regression') {
      out.push(s)
      continue
    }
    if (m === 'regression_only') continue
    // scoped：task 卷必须有 pages 且与改动有交集
    let pages = []
    try {
      pages = s.pages_json ? JSON.parse(s.pages_json) : []
    } catch {
      pages = []
    }
    if (!Array.isArray(pages) || !pages.length) continue
    const files = (Array.isArray(changedFiles) ? changedFiles : [])
      .map((f) => String(f || '').replace(/\\/g, '/').toLowerCase())
    if (!files.length) {
      out.push(s)
      continue
    }
    const hit = pages.some((p) => {
      const needle = String(p || '').replace(/\\/g, '/').toLowerCase()
      if (!needle) return false
      return files.some((f) => f.includes(needle) || needle.includes(f))
    })
    if (hit) out.push(s)
  }
  return out
}

/** 内容寻址目录（运维自检用）。 */
export function specStoreRoot() {
  return SPEC_ROOT
}
