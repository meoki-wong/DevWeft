import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { buildSbomDocument, sbomSha256Of } from '../runner/image/sbom.mjs'
import {
  publishImage, promoteImage, rollbackImage, revokeImage, getActiveImage,
} from '../runner/image/lifecycle.mjs'
import {
  imageManifestDocument, buildImageManifest, buildSignedImageManifest,
} from '../runner/image/manifest.mjs'
import {
  ensureImageSigningKey, rotateImageSigningKey, verifyImageManifestSignature,
} from '../testing/signing.js'
import { verifyImageOrThrow } from '../runner/host-worker/index.mjs'
import { canonicalize, documentSha256 } from '../contracts/version.mjs'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-img-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

describe('M3.1 image SBOM', () => {
  it('builds a canonical SBOM from the golden component manifest', () => {
    const doc = buildSbomDocument({
      imageId: 'win2025-pw-node22-20260905.1',
      generatedAt: '2026-09-05T00:00:00.000Z',
      components: [
        { name: 'git', version: '2.54.0', source: 'git-scm.com' },
        { name: 'node', version: '22.22.3', source: 'nodejs.org' },
        { name: 'playwright', version: '1.49.1', source: 'npm' },
      ],
    })
    expect(doc.components.map((c) => c.name)).toEqual(['git', 'node', 'playwright'])
    expect(sbomSha256Of(doc)).toMatch(/^[a-f0-9]{64}$/)
    // 相同输入产生相同摘要（确定性）
    const again = buildSbomDocument({
      imageId: 'win2025-pw-node22-20260905.1',
      generatedAt: '2026-09-05T00:00:00.000Z',
      components: [
        { name: 'node', version: '22.22.3', source: 'nodejs.org' },
        { name: 'playwright', version: '1.49.1', source: 'npm' },
        { name: 'git', version: '2.54.0', source: 'git-scm.com' },
      ],
    })
    expect(sbomSha256Of(again)).toBe(sbomSha256Of(doc))
  })
})

describe('M3.1 image lifecycle (canary/active/retired + N-1 rollback)', () => {
  it('publishes canary, promotes to active, retires previous, rolls back and revokes', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const first = await getActiveImage(db)
    expect(first.image_id).toBe('win2025-pw-node22-20260903.1')

    // 补丁升级：发布新 image_id（canary 阶段不影响现网绑定）
    const manifest = buildImageManifest({ imageId: 'win2025-pw-node22-20260905.1', vhdxSha256: 'a'.repeat(64) })
    await publishImage(db, {
      imageId: 'win2025-pw-node22-20260905.1',
      manifestSha256: manifest.manifestSha256,
      vhdxSha256: manifest.vhdxSha256,
      manifestJson: canonicalize(manifest.document),
      mode: 'canary',
    })
    expect((await getActiveImage(db)).image_id).toBe('win2025-pw-node22-20260903.1')

    // canary -> active：旧 active 转 retired（N-1 回退点）
    await promoteImage(db, 'win2025-pw-node22-20260905.1')
    expect((await getActiveImage(db)).image_id).toBe('win2025-pw-node22-20260905.1')
    expect((await db.prepare('SELECT state FROM runner_images WHERE image_id=?').get('win2025-pw-node22-20260903.1')).state).toBe('retired')

    // 回退：retired -> active，当前 active 回到 retired
    await rollbackImage(db, { toImageId: 'win2025-pw-node22-20260903.1' })
    expect((await getActiveImage(db)).image_id).toBe('win2025-pw-node22-20260903.1')

    // revoke 后不能被选择
    await revokeImage(db, 'win2025-pw-node22-20260905.1')
    expect((await db.prepare('SELECT state FROM runner_images WHERE image_id=?').get('win2025-pw-node22-20260905.1')).state).toBe('revoked')
    await expect(rollbackImage(db, { toImageId: 'win2025-pw-node22-20260905.1' })).rejects.toThrow(/not retired/)
  })
})

describe('M3.1 signed image manifest and key rotation', () => {
  it('signs the manifest, rejects tampering and supports verify_only rotation', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    await ensureImageSigningKey(db)
    const document = imageManifestDocument({
      imageId: 'win2025-pw-node22-20260905.1',
      vhdxSha256: 'b'.repeat(64),
      sbomSha256: 'c'.repeat(64),
    })
    const envelope = (await buildSignedImageManifest(db, document)).envelope
    expect(envelope.signingKeyId).toBeTruthy()
    expect(await verifyImageManifestSignature(db, envelope)).toBe(true)

    const tampered = { ...envelope, document: { ...document, vhdxSha256: 'd'.repeat(64) } }
    expect(await verifyImageManifestSignature(db, tampered)).toBe(false)

    // 轮换：旧 key -> verify_only，仍可验证历史 manifest；新 key 接管签名
    const rotation = await rotateImageSigningKey(db)
    expect(await verifyImageManifestSignature(db, envelope)).toBe(true)
    const envelope2 = (await buildSignedImageManifest(db, document)).envelope
    expect(envelope2.signingKeyId).toBe(rotation.newKeyId)
    expect(envelope2.signingKeyId).not.toBe(envelope.signingKeyId)
    // 旧 key 被 revoke 后历史 manifest 不再可验证
    await db.prepare(`UPDATE signing_keys SET status='revoked' WHERE key_id=?`).run(rotation.oldKeyId)
    expect(await verifyImageManifestSignature(db, envelope)).toBe(false)
  })

  it('verifyImageOrThrow accepts signed image and rejects tampered manifest', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    await ensureImageSigningKey(db)
    const dir = mkdtempSync(join(tmpdir(), 'awp-imgvhdx-'))
    const vhdxPath = join(dir, 'golden.vhdx')
    writeFileSync(vhdxPath, 'fake-vhdx-bytes')
    const digest = createHash('sha256').update(readFileSync(vhdxPath)).digest('hex')
    await db.prepare(`UPDATE runner_images SET vhdx_sha256=? WHERE image_id=?`).run(digest, 'win2025-pw-node22-20260903.1')
    const document = imageManifestDocument({
      imageId: 'win2025-pw-node22-20260903.1',
      vhdxSha256: digest,
      sbomSha256: 'c'.repeat(64),
    })
    const envelope = (await buildSignedImageManifest(db, document)).envelope
    await db.prepare(
      `UPDATE runner_images SET manifest_sha256=?, manifest_json=? WHERE image_id=?`
    ).run(documentSha256(envelope), canonicalize(envelope), 'win2025-pw-node22-20260903.1')
    await verifyImageOrThrow(db, await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get('win2025-pw-node22-20260903.1'), vhdxPath)

    // 篡改 manifest_json -> IMAGE_CHANGED
    const bad = { ...envelope, document: { ...document, vhdxSha256: 'e'.repeat(64) } }
    await db.prepare(`UPDATE runner_images SET manifest_json=? WHERE image_id=?`)
      .run(canonicalize(bad), 'win2025-pw-node22-20260903.1')
await expect(verifyImageOrThrow(
      db,
      await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get('win2025-pw-node22-20260903.1'),
      vhdxPath,
    )).rejects.toThrow(/IMAGE_CHANGED/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps legacy unsigned manifest rows verifiable for rollback compatibility', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const dir = mkdtempSync(join(tmpdir(), 'awp-imglegacy-'))
    const vhdxPath = join(dir, 'golden.vhdx')
    writeFileSync(vhdxPath, 'legacy-bytes')
    const digest = createHash('sha256').update(readFileSync(vhdxPath)).digest('hex')
    const legacyDoc = { schemaVersion: 1, imageId: 'win2025-pw-node22-20260903.1', vhdxSha256: digest, sbomSha256: 'c'.repeat(64) }
    await db.prepare(`UPDATE runner_images SET vhdx_sha256=?, manifest_sha256=?, manifest_json=? WHERE image_id=?`)
      .run(digest, documentSha256(legacyDoc), canonicalize(legacyDoc), 'win2025-pw-node22-20260903.1')
    await verifyImageOrThrow(db, await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get('win2025-pw-node22-20260903.1'), vhdxPath)
    expect(existsSync(vhdxPath)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
