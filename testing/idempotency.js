import { documentSha256 } from '../contracts/version.mjs'
import { ApiError } from './errors.js'

export async function rememberIdempotency(db, {
  principalId,
  repoId,
  route,
  idempotencyKey,
  requestBody,
  produce,
  now = new Date(),
  ttlMs = 30 * 24 * 60 * 60 * 1000,
}) {
  const requestSha256 = documentSha256(requestBody)
  const existing = await db.prepare(
    `SELECT * FROM idempotency_records WHERE principal_id=? AND route=? AND idempotency_key=?`
  ).get(principalId, route, idempotencyKey)
  if (existing) {
    if (existing.request_sha256 !== requestSha256) throw new ApiError('IDEMPOTENCY_KEY_REUSED')
    return { replay: true, status: existing.response_status, json: JSON.parse(existing.response_json) }
  }
  // produce 在所有调用点都是 async：漏 await 会让 result 成为 Promise，
  // result.status / result.json 均为 undefined → 幂等记录落库 NULL，
  // 且调用方 res.status(undefined) 抛 TypeError 被误报成 400 INVALID_SCHEMA。
  const result = await produce()
  await db.prepare(
    `INSERT INTO idempotency_records(
       principal_id, repo_id, route, idempotency_key, request_sha256,
       response_status, response_json, created_at, expire_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    principalId,
    repoId || null,
    route,
    idempotencyKey,
    requestSha256,
    result.status,
    JSON.stringify(result.json),
    now.toISOString(),
    new Date(now.getTime() + ttlMs).toISOString()
  )
  return { replay: false, ...result }
}
