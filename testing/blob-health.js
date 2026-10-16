import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'

const localRecovery = 'restore_from_backup_or_replicate_blob_root'
const remoteRecovery = 'retry_submission_after_remote_blob_restore'

/** Inspect the authoritative local blob directory without creating or modifying data. */
export async function inspectLocalBlobStore(rootDir) {
  try {
    await fs.access(rootDir, fsConstants.R_OK | fsConstants.W_OK)
    const stat = await fs.stat(rootDir)
    if (!stat.isDirectory()) throw new Error('not_directory')
    let freeBytes
    if (typeof fs.statfs === 'function') {
      const capacity = await fs.statfs(rootDir)
      freeBytes = Number(capacity.bavail) * Number(capacity.bsize)
    }
    return {
      ok: true,
      mode: 'local',
      state: 'available',
      localCache: false,
      durability: 'host-local',
      recovery: localRecovery,
      ...(Number.isFinite(freeBytes) ? { freeBytes } : {}),
    }
  } catch {
    return {
      ok: false,
      mode: 'local',
      state: 'local_storage_unavailable',
      localCache: false,
      durability: 'host-local',
      recovery: localRecovery,
    }
  }
}

/** Probe a remote blob endpoint using its readiness route; never return URL or error text. */
export async function probeRemoteBlobStore(baseUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '')
  const common = {
    mode: 'remote',
    localCache: false,
    durability: 'remote-primary',
    recovery: remoteRecovery,
  }
  if (!normalizedBase) {
    return { ...common, ok: false, state: 'remote_not_configured' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(`${normalizedBase}/api/health/ready`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return { ...common, ok: false, state: 'remote_unavailable' }
    const payload = await response.json().catch(() => null)
    if (payload?.ready !== true) return { ...common, ok: false, state: 'remote_unavailable' }
    return { ...common, ok: true, state: 'available' }
  } catch {
    return { ...common, ok: false, state: 'remote_unavailable' }
  } finally {
    clearTimeout(timer)
  }
}
