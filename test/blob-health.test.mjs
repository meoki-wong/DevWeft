import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { inspectLocalBlobStore, probeRemoteBlobStore } from '../testing/blob-health.js'
import { mountTestingRoutes } from '../testing/routes.js'

describe('blob storage readiness probes', () => {
  it('checks the local authoritative store without exposing its path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'devweft-blob-health-'))
    const healthy = await inspectLocalBlobStore(root)
    expect(healthy).toMatchObject({
      ok: true,
      mode: 'local',
      state: 'available',
      localCache: false,
      durability: 'host-local',
      recovery: 'restore_from_backup_or_replicate_blob_root',
    })
    expect(JSON.stringify(healthy)).not.toContain(root)

    const unavailable = await inspectLocalBlobStore(path.join(root, 'missing'))
    expect(unavailable).toMatchObject({ ok: false, state: 'local_storage_unavailable' })
  })

  it('requires the remote readiness contract and never returns endpoint details', async () => {
    const healthy = await probeRemoteBlobStore('https://host.example:8792/', {
      fetchImpl: async (url) => {
        expect(url).toBe('https://host.example:8792/api/health/ready')
        return { ok: true, json: async () => ({ ready: true }) }
      },
    })
    expect(healthy).toMatchObject({ ok: true, state: 'available', mode: 'remote', localCache: false })
    expect(JSON.stringify(healthy)).not.toContain('host.example')

    const unavailable = await probeRemoteBlobStore('https://host.example:8792', {
      fetchImpl: async () => { throw new Error('connection refused at secret-host') },
    })
    expect(unavailable).toMatchObject({
      ok: false,
      state: 'remote_unavailable',
      recovery: 'retry_submission_after_remote_blob_restore',
    })
    expect(JSON.stringify(unavailable)).not.toContain('secret-host')
  })

  it('reports a missing remote endpoint as unconfigured without attempting a request', async () => {
    let called = false
    const status = await probeRemoteBlobStore('', { fetchImpl: async () => { called = true } })
    expect(called).toBe(false)
    expect(status).toMatchObject({ ok: false, state: 'remote_not_configured', localCache: false })
  })

  it('does not create a local blob store or accept canonical uploads on a standby', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'devweft-standby-blobs-'))
    const blobRoot = path.join(root, 'must-not-exist')
    const app = express()
    app.use(express.json())
    mountTestingRoutes(app, { database: {}, blobRoot, disableBlobRoutes: true })
    const server = app.listen(0)
    await new Promise((resolve) => server.on('listening', resolve))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/blobs:prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'git-bundle', sha256: 'a'.repeat(64), size: 3 }),
    })
    const body = await response.json()
    expect(response.status).toBe(503)
    expect(body.error.code).toBe('BLOB_STORE_UNAVAILABLE')
    expect(await import('node:fs').then(({ existsSync }) => existsSync(blobRoot))).toBe(false)
    server.close()
  })
})
