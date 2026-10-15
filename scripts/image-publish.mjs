// 仅 sqlite（方案 §2.8/§7）：直接打开 data/team.db 的离线/运维工具，未做 postgres 方言迁移；
// PG 切换后如需使用，先改造为 openDb() 句柄。
/**
 * 镜像发布 CLI（§9.2 / §23 M3.1）：
 *   publish : 从 VHDX 构建（签名）manifest + SBOM 摘要，登记 canary 或直接 active
 *   promote / rollback / revoke / list
 * 镜像禁止原地升级：补丁升级 = 新 image_id publish -> promote；N-1 回退 = rollback。
 *
 * 用法：
 *   node scripts/image-publish.mjs publish --image-id <id> --vhdx <golden.vhdx> [--sbom <sbom.json>] [--mode canary|active]
 *   node scripts/image-publish.mjs promote --image-id <id>
 *   node scripts/image-publish.mjs rollback --image-id <id>
 *   node scripts/image-publish.mjs revoke --image-id <id>
 *   node scripts/image-publish.mjs list
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runTestingMigrations } from '../testing/migrate.js'
import { canonicalize, documentSha256 } from '../contracts/version.mjs'
import { buildImageManifest, buildSignedImageManifest, imageManifestDocument } from '../runner/image/manifest.mjs'
import { sbomSha256Of, buildSbomFromComponentsFile } from '../runner/image/sbom.mjs'
import { publishImage, promoteImage, rollbackImage, revokeImage } from '../runner/image/lifecycle.mjs'
import { ensureImageSigningKey } from '../testing/signing.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const command = process.argv[2]

const db = new Database(join(repoRoot, 'data', 'team.db'))
db.pragma('foreign_keys = ON')
runTestingMigrations(db)

function requireArg(name, value) {
  if (!value) {
    process.stderr.write(`缺少 ${name}\n`)
    process.exit(2)
  }
  return value
}

function buildSignedFromVhdx({ imageId, vhdxPath, sbomPath }) {
  if (!existsSync(vhdxPath)) {
    process.stderr.write(`缺少 VHDX: ${vhdxPath}\n`)
    process.exit(2)
  }
  ensureImageSigningKey(db)
  let sbomSha = null
  if (sbomPath && existsSync(sbomPath)) {
    sbomSha = sbomSha256Of(JSON.parse(readFileSync(sbomPath, 'utf8')))
  } else if (sbomPath) {
    process.stderr.write(`缺少 SBOM: ${sbomPath}\n`)
    process.exit(2)
  }
  const manifest = buildImageManifest({ imageId, vhdxPath, sbomSha256: sbomSha })
  const document = sbomSha
    ? imageManifestDocument({ imageId, vhdxSha256: manifest.vhdxSha256, sbomSha256: sbomSha })
    : manifest.document
  const signed = buildSignedImageManifest(db, document)
  return {
    document: signed.envelope.document,
    envelope: signed.envelope,
    manifestSha256: signed.manifestSha256,
    vhdxSha256: document.vhdxSha256,
  }
}

if (command === 'publish') {
  const imageId = requireArg('--image-id', arg('--image-id'))
  const vhdxPath = resolve(requireArg('--vhdx', arg('--vhdx')))
  const sbomPath = arg('--sbom') ? resolve(arg('--sbom')) : null
  const mode = arg('--mode') || 'canary'
  const built = buildSignedFromVhdx({ imageId, vhdxPath, sbomPath })
  const row = publishImage(db, {
    imageId,
    manifestSha256: built.manifestSha256,
    vhdxSha256: built.vhdxSha256,
    manifestJson: canonicalize(built.envelope),
    mode,
  })
  process.stdout.write(`published ${row.image_id} state=${row.state} vhdx=${row.vhdx_sha256.slice(0, 12)}… manifest=${row.manifest_sha256.slice(0, 12)}…\n`)
} else if (command === 'promote') {
  const row = promoteImage(db, requireArg('--image-id', arg('--image-id')))
  process.stdout.write(`promoted ${row.image_id} state=${row.state}\n`)
} else if (command === 'rollback') {
  const row = rollbackImage(db, { toImageId: requireArg('--image-id', arg('--image-id')) })
  process.stdout.write(`rollback ok, active=${row.image_id}\n`)
} else if (command === 'revoke') {
  const row = revokeImage(db, requireArg('--image-id', arg('--image-id')))
  process.stdout.write(`revoked ${row.image_id} state=${row.state}\n`)
} else if (command === 'list') {
  for (const row of db.prepare('SELECT image_id, state, vhdx_sha256, created_at, retired_at FROM runner_images ORDER BY created_at').all()) {
    process.stdout.write(`${row.image_id}\t${row.state}\t${row.vhdx_sha256.slice(0, 12)}…\t${row.created_at}\n`)
  }
} else {
  process.stderr.write('未知命令。可用：publish | promote | rollback | revoke | list\n')
  process.exit(2)
}
void documentSha256
