import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export const BACKUP_MANIFEST_VERSION = 1

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export function listRegularFiles(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  const walk = (base, prefix = '') => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const fullPath = path.join(base, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`backup artifact symlinks are not supported: ${relative}`)
      if (entry.isDirectory()) walk(fullPath, relative)
      else if (entry.isFile()) result.push({ fullPath, relative })
      else throw new Error(`unsupported backup artifact entry: ${relative}`)
    }
  }
  walk(root)
  return result
}

export function copyArtifactDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of listRegularFiles(source)) {
    const relativeParts = entry.relative.split('/')
    if (relativeParts.some((part) => part === '.' || part === '..' || part.length === 0)) {
      throw new Error(`invalid artifact path: ${entry.relative}`)
    }
    const target = path.join(destination, ...relativeParts)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(entry.fullPath, target, fs.constants.COPYFILE_EXCL)
  }
}

export async function describeArtifacts(root) {
  return Promise.all(listRegularFiles(root).map(async ({ fullPath, relative }) => ({
    path: relative,
    bytes: fs.statSync(fullPath).size,
    sha256: await sha256File(fullPath),
  })))
}

export function assertSafeRelativePath(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new Error(`invalid artifact path in backup manifest: ${String(relative)}`)
  }
  const parts = relative.replace(/\\/g, '/').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid artifact path in backup manifest: ${relative}`)
  }
  return parts
}

export async function verifyArtifactDirectory(root, expectedEntries) {
  if (!Array.isArray(expectedEntries)) throw new Error('backup manifest artifact list is invalid')
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) {
    throw new Error('backup artifact directory is missing or is not a regular directory')
  }
  const actual = await describeArtifacts(root)
  if (actual.length !== expectedEntries.length) throw new Error('backup artifact count does not match its manifest')
  const byPath = new Map(actual.map((entry) => [entry.path, entry]))
  for (const expected of expectedEntries) {
    assertSafeRelativePath(expected.path)
    const found = byPath.get(expected.path)
    if (!found || found.bytes !== expected.bytes || found.sha256 !== expected.sha256) {
      throw new Error(`backup artifact verification failed: ${expected.path}`)
    }
  }
}

export async function writeBackupManifest(backupPath, manifest) {
  const manifestPath = `${backupPath}.manifest.json`
  const tempPath = `${manifestPath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(tempPath, manifestPath)
  return manifestPath
}

export async function loadAndVerifyBackup(backupPath) {
  const manifestPath = `${backupPath}.manifest.json`
  if (!fs.existsSync(manifestPath)) throw new Error(`backup manifest is missing: ${manifestPath}`)
  if (fs.lstatSync(backupPath).isSymbolicLink() || fs.lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error('backup files cannot be symbolic links')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.manifestVersion !== BACKUP_MANIFEST_VERSION) throw new Error('unsupported backup manifest version')
  if (!['sqlite', 'postgres'].includes(manifest.dialect)) throw new Error('backup manifest database dialect is invalid')
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('backup manifest timestamp is invalid')
  if (typeof manifest.artifactsIncluded !== 'boolean' || !Array.isArray(manifest.artifacts)) {
    throw new Error('backup manifest artifact metadata is invalid')
  }
  if (manifest.dialect === 'sqlite' && manifest.integrityCheck !== 'ok') throw new Error('SQLite integrity result is invalid')
  if (manifest.dialect === 'postgres' && manifest.integrityCheck !== 'pg_restore list succeeded') {
    throw new Error('PostgreSQL archive verification result is invalid')
  }
  if (manifest.backupFile !== path.basename(backupPath)) throw new Error('backup file name does not match its manifest')
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) throw new Error('backup manifest byte size is invalid')
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) throw new Error('backup manifest SHA-256 is invalid')
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 0) throw new Error('backup schema version is invalid')
  const stat = fs.statSync(backupPath)
  if (!stat.isFile() || stat.size !== manifest.bytes) throw new Error('backup file size does not match its manifest')
  if (await sha256File(backupPath) !== manifest.sha256) throw new Error('backup file SHA-256 does not match its manifest')
  if (manifest.artifactsIncluded) {
    await verifyArtifactDirectory(`${backupPath}.blobs`, manifest.artifacts)
  } else if (manifest.artifacts?.length) {
    throw new Error('backup manifest has artifact entries but artifactsIncluded is false')
  }
  return { manifest, manifestPath }
}
