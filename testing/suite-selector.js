import { ApiError } from './errors.js'
import { loadRevisionManifest } from './suite-registry.js'

const LAYER_RANK = {
  stable: 100,
  repo: 200,
  branch: 300,
  task: 400,
}

export async function selectSuiteLayers(db, {
  repoId,
  taskInstanceId,
  branchIncarnationId = null,
}) {
  const overlays = await db.prepare(
    `SELECT o.* FROM suite_overlays o WHERE o.state='active'`
  ).all()
  const selected = []
  for (const overlay of overlays) {
    if (!await overlayMatches(db, overlay, { repoId, taskInstanceId, branchIncarnationId })) continue
    const channel = await db.prepare(
      `SELECT * FROM suite_channels WHERE overlay_id=? AND channel='active'`
    ).get(overlay.overlay_id)
    if (!channel) continue
    const revision = await db.prepare(
      `SELECT * FROM suite_revisions WHERE suite_revision_id=?`
    ).get(channel.active_revision_id)
    if (!revision) continue
    if (revision.approval_state !== 'reviewed' || revision.publication_state !== 'active') continue
    selected.push({ overlay, revision, rank: LAYER_RANK[overlay.layer], ordinal: overlay.ordinal })
  }
  selected.sort((a, b) => a.rank - b.rank || a.ordinal - b.ordinal || a.overlay.overlay_id.localeCompare(b.overlay.overlay_id))
  return selected
}

async function overlayMatches(db, overlay, { repoId, taskInstanceId, branchIncarnationId }) {
  if (overlay.layer === 'stable') {
    const compat = await db.prepare(
      `SELECT * FROM suite_overlay_repo_compat WHERE overlay_id=? AND repo_id=? AND enabled=1`
    ).get(overlay.overlay_id, repoId)
    return Boolean(compat)
  }
  if (overlay.layer === 'repo') return overlay.repo_id === repoId
  if (overlay.layer === 'branch') {
    return overlay.repo_id === repoId && overlay.branch_incarnation_id && overlay.branch_incarnation_id === branchIncarnationId
  }
  if (overlay.layer === 'task') {
    return overlay.repo_id === repoId && overlay.task_instance_id === taskInstanceId
  }
  return false
}

export function mergeSuiteCases(layers) {
  const byKey = new Map()
  const adopted = []
  for (const layer of layers) {
    const manifest = loadRevisionManifest(layer.revision)
    const cases = Array.isArray(manifest.cases) ? manifest.cases : []
    for (const c of cases) {
      if (c.replacesCaseKey) {
        const prev = byKey.get(c.replacesCaseKey)
        if (prev?.protected) throw new ApiError('PROTECTED_CASE_VIOLATION')
        byKey.delete(c.replacesCaseKey)
      }
      if (byKey.has(c.caseKey)) throw new ApiError('SUITE_CASE_CONFLICT')
      const entry = {
        caseKey: c.caseKey,
        title: c.title,
        tags: c.tags || [],
        protected: Boolean(c.protected),
        replacesCaseKey: c.replacesCaseKey ?? null,
        requiredCapabilities: c.requiredCapabilities || [],
        overlayId: layer.overlay.overlay_id,
        suiteRevisionId: layer.revision.suite_revision_id,
        layer: layer.overlay.layer,
      }
      byKey.set(c.caseKey, entry)
      adopted.push(entry)
    }
  }
  return { cases: [...byKey.values()].sort((a, b) => a.caseKey.localeCompare(b.caseKey)), adopted }
}
