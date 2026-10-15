/**
 * §7.5 promotion publish CAS：把已 published 的 proposal 替换 suite_channels.active_revision_id
 * §7.5 同时更新 candidate channel（先 dual-write，再 CAS）
 * §23 channel CAS 强制 serialized promotion
 */
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'

/** 取给定 overlay 的 active channel；若不存在则自动创建（首次发布） */
async function getOrCreateChannel(db, { overlayId, channel, updatedBy, now = new Date() } = {}) {
  const row = await db.prepare('SELECT * FROM suite_channels WHERE overlay_id=? AND channel=?').get(overlayId, channel)
  if (row) return row
  if (!updatedBy) throw new ApiError('INVALID_SCHEMA')
  // FK active_revision_id REFERENCES suite_revisions — 首次 active 通道需 caller 提供 seed revision
  // 实际首次 active 发布由 publishToChannel 走「seed in same transaction」；这里不能预占
  throw new ApiError('PRECONDITION_FAILED')
}

export async function publishToChannel(db, body, { actorPrincipalId, now = new Date() } = {}) {
  if (!body || !body.proposalId) throw new ApiError('INVALID_SCHEMA')
  const proposal = await db.prepare("SELECT * FROM promotion_proposals WHERE proposal_id=? AND state='published'").get(body.proposalId)
  if (!proposal) throw new ApiError('SUITE_REVOKED')
  if (!proposal.published_revision_id) throw new ApiError('SUITE_REVOKED')
  // 解析 target_suite_revision 的 overlay（CAS publish 改 active channel）
  // v4 suite_revisions 没有 repo_id 列；通过 overlay_id → suite_overlays.repo_id
  const target = await db.prepare(`
    SELECT s.overlay_id, o.repo_id
    FROM suite_revisions s
    JOIN suite_overlays o ON o.overlay_id = s.overlay_id
    WHERE s.suite_revision_id=?
  `).get(proposal.target_suite_revision_id)
  if (!target) throw new ApiError('INVALID_SCHEMA')
  if (!actorPrincipalId) throw new ApiError('INVALID_SCHEMA')

  const nowIso = now.toISOString()
  // dual-write：先写 candidate channel（首次可自动创建）
  let candidateChannel = await db.prepare('SELECT * FROM suite_channels WHERE overlay_id=? AND channel=?').get(target.overlay_id, 'candidate')
  if (!candidateChannel) {
    await db.prepare(
      `INSERT INTO suite_channels(channel_id, overlay_id, channel, active_revision_id, revision, updated_by, updated_at)
       VALUES (?, ?, 'candidate', ?, 0, ?, ?)`
    ).run(uuidv7(), target.overlay_id, proposal.published_revision_id, actorPrincipalId, nowIso)
    candidateChannel = await db.prepare('SELECT * FROM suite_channels WHERE overlay_id=? AND channel=?').get(target.overlay_id, 'candidate')
  } else {
    await db.prepare(
      `UPDATE suite_channels SET active_revision_id=?, revision=revision+1, updated_by=?, updated_at=?
       WHERE overlay_id=? AND channel='candidate'`
    ).run(proposal.published_revision_id, actorPrincipalId, nowIso, target.overlay_id)
  }
  // CAS：替换 active（首次需主动创建；已有则 CAS）
  const tx = async (tx) => {
    const current = await tx.prepare('SELECT * FROM suite_channels WHERE overlay_id=? AND channel=?').get(target.overlay_id, 'active')
    if (!current) {
      // 首次 active 通道：与 candidate 同样的 published_revision_id 初始化
      await tx.prepare(
        `INSERT INTO suite_channels(channel_id, overlay_id, channel, active_revision_id, revision, updated_by, updated_at)
         VALUES (?, ?, 'active', ?, 1, ?, ?)`
      ).run(uuidv7(), target.overlay_id, proposal.published_revision_id, actorPrincipalId, nowIso)
      return { firstActive: true, channelId: (await tx.prepare('SELECT channel_id FROM suite_channels WHERE overlay_id=? AND channel=?').get(target.overlay_id, 'active')).channel_id }
    }
    if (current.active_revision_id === proposal.published_revision_id) {
      return { noop: true, channelId: current.channel_id }
    }
    await tx.prepare(
      `UPDATE suite_channels
       SET active_revision_id=?, revision=revision+1, updated_by=?, updated_at=?
       WHERE overlay_id=? AND channel='active'`
    ).run(proposal.published_revision_id, actorPrincipalId, nowIso, target.overlay_id)
    return { channelId: current.channel_id, newRevision: 'bumped' }
  }
  const result = await db.tx(tx)
  return { proposalId: body.proposalId, overlayId: target.overlay_id, ...result, publishedAt: nowIso }
}

export async function getActiveChannel(db, { overlayId, channel = 'active' } = {}) {
  if (!overlayId) throw new ApiError('INVALID_SCHEMA')
  return await db.prepare(
    'SELECT * FROM suite_channels WHERE overlay_id=? AND channel=?'
  ).get(overlayId, channel) || null
}

export async function listChannels(db, { overlayId } = {}) {
  if (!overlayId) throw new ApiError('INVALID_SCHEMA')
  return await db.prepare('SELECT * FROM suite_channels WHERE overlay_id=? ORDER BY channel').all(overlayId)
}
