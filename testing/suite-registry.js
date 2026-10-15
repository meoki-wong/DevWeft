import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize, documentSha256, sha256Hex } from '../contracts/version.mjs'
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SUITES_ROOT = path.join(root, 'suites')
function listFiles(dir, relBase = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    const rel = relBase ? `${relBase}/${name}` : name
    if (statSync(abs).isDirectory()) {
      out.push(...listFiles(abs, rel))
    } else {
      const buf = readFileSync(abs)
      out.push({
        path: rel.replace(/\\/g, '/'),
        sha256: sha256Hex(buf),
        content: buf.toString('utf8'),
      })
    }
  }
  return out
}

function loadOverlayDir(absDir) {
  const files = listFiles(absDir)
  const manifestFile = files.find((f) => f.path === 'manifest.json')
  if (!manifestFile) throw new Error(`missing manifest.json in ${absDir}`)
  const manifest = JSON.parse(manifestFile.content)
  const manifestSha256 = documentSha256(manifest)
  const fileIndex = files.map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path))
  const treeOid = documentSha256(fileIndex)
  const contentSha256 = documentSha256({ manifest, files: fileIndex })
  return { manifest, manifestSha256, files, fileIndex, treeOid, contentSha256 }
}

export async function seedSuiteRegistry(db, { repoId, suiteSlug, createdBy, now = utcNow() } = {}) {
  if (!repoId || !createdBy) return
  if (!suiteSlug) return
  const slug = suiteSlug
  const stableDir = path.join(SUITES_ROOT, slug, 'stable')
  const repoDir = path.join(SUITES_ROOT, slug, 'repo')
  if (!existsSync(stableDir) || !existsSync(repoDir)) return
  const prefix = slug
  await publishOverlayFromDir(db, {
    absDir: stableDir,
    logicalName: `${prefix}-stable-static`,
    layer: 'stable',
    repoId: null,
    createdBy,
    now,
    compatRepoId: repoId,
  })
  await publishOverlayFromDir(db, {
    absDir: repoDir,
    logicalName: `${prefix}-repo-static`,
    layer: 'repo',
    repoId,
    createdBy,
    now,
    compatRepoId: repoId,
  })
}

async function publishOverlayFromDir(db, {
  absDir,
  logicalName,
  layer,
  repoId,
  createdBy,
  now,
  compatRepoId,
}) {
  const loaded = loadOverlayDir(absDir)
  let overlay = await db.prepare(
    `SELECT * FROM suite_overlays WHERE logical_name=? AND layer=? AND COALESCE(repo_id,'')=COALESCE(?,'')`
  ).get(logicalName, layer, repoId)
  if (!overlay) {
    const overlayId = uuidv7()
    await db.prepare(
      `INSERT INTO suite_overlays(
         overlay_id, logical_name, layer, repo_id, branch_incarnation_id, task_instance_id,
         ordinal, protected, state, created_by, created_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, 0, 1, 'active', ?, ?)`
    ).run(overlayId, logicalName, layer, repoId, createdBy, now)
    overlay = await db.prepare('SELECT * FROM suite_overlays WHERE overlay_id=?').get(overlayId)
  }
  if (compatRepoId) {
    await db.prepare(
      `INSERT INTO suite_overlay_repo_compat(
         overlay_id, repo_id, required_capabilities_json, min_profile_revision, enabled
       ) VALUES (?, ?, '[]', NULL, 1)
       ON CONFLICT DO NOTHING`
    ).run(overlay.overlay_id, compatRepoId)
  }
  const existingRev = await db.prepare(
    `SELECT * FROM suite_revisions WHERE overlay_id=? AND content_sha256=? AND manifest_sha256=?`
  ).get(overlay.overlay_id, loaded.contentSha256, loaded.manifestSha256)
  let revisionRow = existingRev
  if (!revisionRow) {
    const maxRev = (await db.prepare(
      `SELECT COALESCE(MAX(revision),0) AS n FROM suite_revisions WHERE overlay_id=?`
    ).get(overlay.overlay_id)).n
    const suiteRevisionId = uuidv7()
    await db.prepare(
      `INSERT INTO suite_revisions(
         suite_revision_id, overlay_id, revision, source_kind, source_commit_oid, source_tree_path,
         registry_commit_oid, tree_oid, content_sha256, manifest_sha256, manifest_json,
         approval_state, publication_state, previous_revision_id, generated_by_model,
         generated_from_binding_id, expires_at, created_by, created_at
       ) VALUES (?, ?, ?, 'reviewed_git', NULL, ?, NULL, ?, ?, ?, ?, 'reviewed', 'active', NULL, NULL, NULL, NULL, ?, ?)`
    ).run(
      suiteRevisionId,
      overlay.overlay_id,
      maxRev + 1,
      path.relative(root, absDir).replace(/\\/g, '/'),
      loaded.treeOid,
      loaded.contentSha256,
      loaded.manifestSha256,
      canonicalize(loaded.manifest),
      createdBy,
      now
    )
    await db.prepare(
      `INSERT INTO suite_revision_events(
         event_id, suite_revision_id, event_type, state_axis, from_state, to_state, reason, actor_principal_id, created_at
       ) VALUES (?, ?, 'approved', 'approval', 'unreviewed', 'reviewed', 'seed', ?, ?)`
    ).run(uuidv7(), suiteRevisionId, createdBy, now)
    await db.prepare(
      `INSERT INTO suite_revision_events(
         event_id, suite_revision_id, event_type, state_axis, from_state, to_state, reason, actor_principal_id, created_at
       ) VALUES (?, ?, 'promoted', 'publication', 'draft', 'active', 'seed', ?, ?)`
    ).run(uuidv7(), suiteRevisionId, createdBy, now)
    revisionRow = await db.prepare('SELECT * FROM suite_revisions WHERE suite_revision_id=?').get(suiteRevisionId)
  }
  const channel = await db.prepare(
    `SELECT * FROM suite_channels WHERE overlay_id=? AND channel='active'`
  ).get(overlay.overlay_id)
  if (!channel) {
    await db.prepare(
      `INSERT INTO suite_channels(channel_id, overlay_id, channel, active_revision_id, revision, updated_by, updated_at)
       VALUES (?, ?, 'active', ?, 1, ?, ?)`
    ).run(uuidv7(), overlay.overlay_id, revisionRow.suite_revision_id, createdBy, now)
  } else if (channel.active_revision_id !== revisionRow.suite_revision_id) {
    const info = await db.prepare(
      `UPDATE suite_channels SET active_revision_id=?, revision=revision+1, updated_by=?, updated_at=?
       WHERE overlay_id=? AND channel='active' AND revision=?`
    ).run(revisionRow.suite_revision_id, createdBy, now, overlay.overlay_id, channel.revision)
    if (info.changes !== 1) throw new ApiError('PRECONDITION_FAILED')
  }
  return revisionRow
}

export function loadRevisionManifest(revisionRow) {
  return JSON.parse(revisionRow.manifest_json)
}

export function sha256FileBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
