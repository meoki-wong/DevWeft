/**
 * Runner image 生命周期（§9.2/§23 M3.1）：
 *   publishImage(canary|active) -> promoteImage -> retired（N-1 回退点）-> rollbackImage / revokeImage。
 * 镜像禁止原地升级：补丁升级 = 发布新 image_id 后 promote；active 镜像唯一。
 */
import { ApiError } from '../../testing/errors.js'

const ACTIVE_STATES = new Set(['canary', 'active', 'retired', 'revoked'])

function assertImageId(imageId) {
  if (!imageId || typeof imageId !== 'string' || imageId.length > 128) throw new ApiError('INVALID_SCHEMA')
}

export async function getActiveImage(db) {
  const row = await db.prepare(`SELECT * FROM runner_images WHERE state='active' ORDER BY created_at DESC LIMIT 1`).get()
  if (!row) throw new ApiError('INVALID_SCHEMA')
  return row
}

export async function publishImage(db, {
  imageId, manifestSha256, vhdxSha256, manifestJson, mode = 'canary', now = new Date().toISOString(),
} = {}) {
  assertImageId(imageId)
  if (!ACTIVE_STATES.has(mode)) throw new ApiError('INVALID_SCHEMA')
  if (!/^[a-f0-9]{64}$/.test(vhdxSha256 || '') || !/^[a-f0-9]{64}$/.test(manifestSha256 || '')) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (await db.prepare('SELECT 1 FROM runner_images WHERE image_id=?').get(imageId)) {
    throw new ApiError('IMAGE_CHANGED')
  }
  const tx = async (txDb) => {
    await txDb.prepare(
      `INSERT INTO runner_images(image_id, manifest_sha256, vhdx_sha256, manifest_json, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(imageId, manifestSha256, vhdxSha256, manifestJson, mode, now)
    if (mode === 'active') await retireCurrentActive(txDb, imageId, now)
  }
  await db.tx(tx)
  return await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get(imageId)
}

async function retireCurrentActive(db, exceptImageId, now) {
  await db.prepare(
    `UPDATE runner_images SET state='retired', retired_at=? WHERE state='active' AND image_id<>?`
  ).run(now, exceptImageId)
}

export async function promoteImage(db, imageId, { now = new Date().toISOString() } = {}) {
  assertImageId(imageId)
  const row = await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get(imageId)
  if (!row || row.state !== 'canary') throw new ApiError('INVALID_SCHEMA')
  const tx = async (tx) => {
    await retireCurrentActive(tx, imageId, now)
    await tx.prepare(`UPDATE runner_images SET state='active', retired_at=NULL WHERE image_id=?`).run(imageId)
  }
  await db.tx(tx)
  return await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get(imageId)
}

export async function rollbackImage(db, { toImageId, now = new Date().toISOString() } = {}) {
  assertImageId(toImageId)
  const row = await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get(toImageId)
  if (!row || row.state !== 'retired') throw new Error(`rollback target ${toImageId} not retired`)
  const tx = async (tx) => {
    await retireCurrentActive(tx, toImageId, now)
    await tx.prepare(`UPDATE runner_images SET state='active', retired_at=NULL WHERE image_id=?`).run(toImageId)
  }
  await db.tx(tx)
  return await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get(toImageId)
}

export async function revokeImage(db, imageId, { now = new Date().toISOString() } = {}) {
  assertImageId(imageId)
  await db.prepare(`UPDATE runner_images SET state='revoked', retired_at=? WHERE image_id=? AND state IN ('canary','retired')`)
    .run(now, imageId)
  return await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get(imageId)
}

export async function retireExpiredCanaries(db, { olderThanMs = 7 * 24 * 3600 * 1000, now = new Date() } = {}) {
  const deadline = new Date(now.getTime() - olderThanMs).toISOString()
  await db.prepare(`UPDATE runner_images SET state='revoked', retired_at=? WHERE state='canary' AND created_at < ?`)
    .run(now.toISOString(), deadline)
}
