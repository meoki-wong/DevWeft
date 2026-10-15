import {
  createPrincipal,
  findPrincipalBySubject,
  grantGlobalRole,
  grantRepoPermissions,
  issueToken,
} from './auth.js'
import { ensureRepository, SYSTEM_SUBJECT } from './migrate.js'
import { canonicalizeRemoteUrl, registerRemote } from './remotes.js'
import { canonicalize, documentSha256 } from '../contracts/version.mjs'
import { uuidv7, utcNow } from './ids.js'
import { ensureRepoGateMode } from '../harness/testing-gate.js'
import { defaultExecutionProfileDocument, DEFAULT_IMAGE_ID, DEFAULT_PROFILE_NAME } from './execution-profiles.js'
import { seedSuiteRegistry } from './suite-registry.js'
import { getRepoPlatformProfile } from './repo-platform.js'
import { ensureRunspecSigningKey } from './signing.js'
import { buildImageManifest } from '../runner/image/manifest.mjs'

export const BOOTSTRAP_SUBJECT = 'bootstrap-admin'

export const ALL_REPO_PERMISSIONS = [
  'submit',
  'read_result',
  'create_candidate',
  'review_candidate',
  'promote_suite',
  'triage_failure',
  'administer',
]

export async function bootstrapTestingPlatform(db, {
  slug = 'demo-app',
  remoteUrl = null,
  rotateToken = false,
} = {}) {
  const system = await findPrincipalBySubject(db, SYSTEM_SUBJECT)
  const systemId = system.principal_id
  const principalId = await createPrincipal(db, {
    subject: BOOTSTRAP_SUBJECT,
    displayName: 'Bootstrap Admin',
  })
  const repoId = await ensureRepository(db, slug, systemId)
  await ensureRepoGateMode(db, repoId, slug)
  await grantGlobalRole(db, { principalId, role: 'test_admin', grantedBy: systemId })
  await grantGlobalRole(db, { principalId, role: 'developer', grantedBy: systemId })
  await grantRepoPermissions(db, { principalId, repoId, permissions: ALL_REPO_PERMISSIONS })
  await seedBaselineRunner(db, { repoId, createdBy: systemId })
  const profile = getRepoPlatformProfile(slug)
  if (profile?.suiteSlug) {
    await seedSuiteRegistry(db, { repoId, suiteSlug: profile.suiteSlug, createdBy: systemId })
  }
  await ensureRunspecSigningKey(db)
  let remote = null
  if (remoteUrl) {
    remote = await registerRemote(db, {
      repoId,
      url: remoteUrl,
      provider: 'gitlab',
      providerInstance: new URL(canonicalizeRemoteUrl(remoteUrl)).host,
    })
  }
  const tokens = await db.prepare(
    `SELECT token_id FROM principal_tokens WHERE principal_id=? AND revoked_at IS NULL AND expires_at > ?`
  ).all(principalId, new Date().toISOString())
  let token = null
  let tokenId = null
  if (rotateToken || tokens.length === 0) {
    const issued = await issueToken(db, { principalId })
    token = issued.token
    tokenId = issued.tokenId
  }
  return {
    principalId,
    repoId,
    slug,
    remoteId: remote ? remote.remote_id : null,
    canonicalUrl: remote ? remote.canonical_url : null,
    token,
    tokenId,
    tokenReuse: token == null,
  }
}

export async function seedBaselineRunner(db, { repoId, createdBy, now = utcNow() }) {
  const emptySha = documentSha256({})
  if (!await db.prepare(`SELECT 1 FROM policy_revisions WHERE state='active'`).get()) {
    await db.prepare(
      `INSERT INTO policy_revisions(policy_revision_id, name, revision, content_sha256, policy_json, state, created_by, created_at)
       VALUES (?, 'default', 1, ?, '{}', 'active', ?, ?)`
    ).run(uuidv7(), emptySha, createdBy, now)
  }
  await seedDefaultProfile(db, { repoId, createdBy, now })
  await seedActiveImage(db, { now })
}

async function seedDefaultProfile(db, { repoId, createdBy, now }) {
  const profileId = uuidv7()
  const doc = defaultExecutionProfileDocument({ profileRevisionId: profileId, repoId })
  const contentSha = documentSha256(doc)
  const same = await db.prepare(
    `SELECT * FROM execution_profile_revisions WHERE repo_id=? AND content_sha256=?`
  ).get(repoId, contentSha)
  if (same) {
    if (same.state !== 'active') {
      await db.prepare(`UPDATE execution_profile_revisions SET state='deprecated' WHERE repo_id=? AND state='active'`).run(repoId)
      await db.prepare(`UPDATE execution_profile_revisions SET state='active' WHERE profile_revision_id=?`).run(same.profile_revision_id)
    }
    return
  }
  await db.prepare(`UPDATE execution_profile_revisions SET state='deprecated' WHERE repo_id=? AND state='active'`).run(repoId)
  const maxRev = (await db.prepare(
    `SELECT COALESCE(MAX(revision),0) AS n FROM execution_profile_revisions WHERE repo_id=? AND name=?`
  ).get(repoId, DEFAULT_PROFILE_NAME)).n
  await db.prepare(
    `INSERT INTO execution_profile_revisions(
       profile_revision_id, repo_id, name, revision, content_sha256, profile_json, state, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(profileId, repoId, DEFAULT_PROFILE_NAME, maxRev + 1, contentSha, canonicalize(doc), createdBy, now)
}

async function seedActiveImage(db, { now }) {
  const imageId = DEFAULT_IMAGE_ID
  const vhdxPath = process.env.AWP_RUNNER_VHDX || null
  const built = buildImageManifest({ imageId, vhdxPath })
  const existing = await db.prepare(`SELECT * FROM runner_images WHERE image_id=?`).get(imageId)
  if (!existing) {
    await db.prepare(
      `INSERT INTO runner_images(image_id, manifest_sha256, vhdx_sha256, manifest_json, state, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`
    ).run(imageId, built.manifestSha256, built.vhdxSha256, canonicalize(built.document), now)
    return
  }
  if (existing.manifest_json === '{}') {
    await db.prepare(
      `UPDATE runner_images SET manifest_sha256=?, vhdx_sha256=?, manifest_json=? WHERE image_id=? AND manifest_json='{}'`
    ).run(built.manifestSha256, built.vhdxSha256, canonicalize(built.document), imageId)
  }
}

export async function registerWorker(db, {
  workerId = uuidv7(),
  certificateThumbprint,
  hostname = 'localhost',
  capabilities = { units: ['static'] },
  now = utcNow(),
} = {}) {
  const existing = await db.prepare('SELECT * FROM workers WHERE certificate_thumbprint=?').get(certificateThumbprint)
  if (existing) return existing
  // 证书轮换重绑：同 worker 身份更换证书（指纹变化）时更新绑定，而不是 PK 冲突
  const byId = await db.prepare('SELECT * FROM workers WHERE worker_id=?').get(workerId)
  if (byId) {
    await db.prepare(`UPDATE workers SET certificate_thumbprint=?, hostname=? WHERE worker_id=?`)
      .run(certificateThumbprint, hostname, workerId)
    return await db.prepare('SELECT * FROM workers WHERE worker_id=?').get(workerId)
  }
  await db.prepare(
    `INSERT INTO workers(worker_id, certificate_thumbprint, hostname, capabilities_json, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  ).run(workerId, certificateThumbprint, hostname, JSON.stringify(capabilities), now)
  return await db.prepare('SELECT * FROM workers WHERE worker_id=?').get(workerId)
}
