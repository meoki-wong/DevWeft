import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BrokerError,
  GRANT_TTL_MAX_MS,
  createGrant,
  fetchGrant,
  openBrokerDb,
  putSecret,
  revokeGrant,
} from '../secret-broker/store.mjs'
import { identityFromCert } from '../secret-broker/server.mjs'

const UUID = {
  grant: '018f0000-0000-7000-8000-0000000000aa',
  worker: '018f0000-0000-7000-8000-0000000000bb',
  lease: '018f0000-0000-7000-8000-0000000000cc',
}

function memoryDb() {
  const dir = mkdtempSync(join(tmpdir(), 'awp-broker-'))
  return openBrokerDb(join(dir, 'broker.db'))
}

function issuedGrant(db, now = new Date('2026-09-03T08:00:00.000Z')) {
  putSecret(db, 'npm-readonly-v1', 'token-plaintext-value', now)
  createGrant(
    db,
    {
      secretGrantId: UUID.grant,
      secretRef: 'npm-readonly-v1',
      workerId: UUID.worker,
      leaseId: UUID.lease,
      capability: 'npm-readonly-v1',
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    },
    now
  )
}

describe('secret broker store', () => {
  it('returns plaintext once then GRANT_ALREADY_FETCHED', () => {
    const db = memoryDb()
    const now = new Date('2026-09-03T08:00:00.000Z')
    issuedGrant(db, now)
    const first = fetchGrant(
      db,
      {
        secretGrantId: UUID.grant,
        workerId: UUID.worker,
        leaseId: UUID.lease,
        capability: 'npm-readonly-v1',
      },
      now
    )
    expect(first.secretRef).toBe('npm-readonly-v1')
    expect(first.plaintext).toBe('token-plaintext-value')
    try {
      fetchGrant(
        db,
        {
          secretGrantId: UUID.grant,
          workerId: UUID.worker,
          leaseId: UUID.lease,
          capability: 'npm-readonly-v1',
        },
        now
      )
      throw new Error('expected second fetch to fail')
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerError)
      expect(err.code).toBe('GRANT_ALREADY_FETCHED')
    }
  })

  it('rejects unknown secret_ref, identity mismatch, expiry and extra fields', () => {
    const db = memoryDb()
    const now = new Date('2026-09-03T08:00:00.000Z')
    expect(() =>
      createGrant(db, {
        secretGrantId: UUID.grant,
        secretRef: 'missing',
        workerId: UUID.worker,
        leaseId: UUID.lease,
        capability: 'npm-readonly-v1',
        expiresAt: new Date(now.getTime() + 60 * 1000).toISOString(),
      }, now)
    ).toThrowError(/SECRET_REF_UNKNOWN/)

    issuedGrant(db, now)
    expect(() =>
      fetchGrant(db, {
        secretGrantId: UUID.grant,
        workerId: UUID.worker,
        leaseId: '018f0000-0000-7000-8000-0000000000dd',
        capability: 'npm-readonly-v1',
      }, now)
    ).toThrowError(/GRANT_IDENTITY_MISMATCH/)

    expect(() =>
      fetchGrant(db, {
        secretGrantId: UUID.grant,
        workerId: UUID.worker,
        leaseId: UUID.lease,
        capability: 'npm-readonly-v1',
        extra: true,
      }, now)
    ).toThrowError(/UNKNOWN_FIELD/)

    expect(() =>
      fetchGrant(db, {
        secretGrantId: UUID.grant,
        workerId: UUID.worker,
        leaseId: UUID.lease,
        capability: 'npm-readonly-v1',
      }, new Date(now.getTime() + 11 * 60 * 1000))
    ).toThrowError(/GRANT_EXPIRED/)
  })

  it('rejects TTL longer than 15 minutes', () => {
    const db = memoryDb()
    const now = new Date('2026-09-03T08:00:00.000Z')
    putSecret(db, 'npm-readonly-v1', 'x', now)
    expect(() =>
      createGrant(db, {
        secretGrantId: UUID.grant,
        secretRef: 'npm-readonly-v1',
        workerId: UUID.worker,
        leaseId: UUID.lease,
        capability: 'npm-readonly-v1',
        expiresAt: new Date(now.getTime() + GRANT_TTL_MAX_MS + 1000).toISOString(),
      }, now)
    ).toThrowError(/INVALID_SCHEMA/)
  })

  it('revoke blocks subsequent fetch', () => {
    const db = memoryDb()
    const now = new Date('2026-09-03T08:00:00.000Z')
    issuedGrant(db, now)
    revokeGrant(db, { secretGrantId: UUID.grant, workerId: UUID.worker, leaseId: UUID.lease }, now)
    expect(() =>
      fetchGrant(db, {
        secretGrantId: UUID.grant,
        workerId: UUID.worker,
        leaseId: UUID.lease,
        capability: 'npm-readonly-v1',
      }, now)
    ).toThrowError(/GRANT_REVOKED/)
  })

  it('maps control-plane vs worker thumbprints', () => {
    const trust = {
      controlPlaneThumbprints: ['aa'],
      workers: [{ workerId: UUID.worker, thumbprint: 'bb' }],
    }
    expect(identityFromCert(trust, 'AA').kind).toBe('control_plane')
    expect(identityFromCert(trust, 'bb').workerId).toBe(UUID.worker)
    expect(identityFromCert(trust, 'cc')).toBeNull()
  })

  it('autostarts under PM2 env even when argv is not the script', async () => {
    const { shouldAutostartBroker } = await import('../secret-broker/server.mjs')
    const self = fileURLToPath(new URL('../secret-broker/server.mjs', import.meta.url))
    expect(shouldAutostartBroker({ env: {}, argv1: 'C:\\pm2\\ProcessContainerFork.js', self })).toBe(false)
    expect(shouldAutostartBroker({ env: { pm_id: '1' }, argv1: 'C:\\pm2\\ProcessContainerFork.js', self })).toBe(true)
    expect(shouldAutostartBroker({ env: { AWP_BROKER_AUTOSTART: '1' }, argv1: 'C:\\pm2\\ProcessContainerFork.js', self })).toBe(true)
    expect(shouldAutostartBroker({ env: { pm_id: '1', AWP_BROKER_NO_LISTEN: '1' }, argv1: self, self })).toBe(false)
    expect(shouldAutostartBroker({ env: {}, argv1: self, self })).toBe(true)
  })

  it('refuses to start HTTP without TLS env', () => {
    const script = fileURLToPath(new URL('../secret-broker/server.mjs', import.meta.url))
    const r = spawnSync(process.execPath, [script], {
      env: { ...process.env, AWP_BROKER_TLS_CERT: '', AWP_BROKER_TLS_KEY: '', AWP_BROKER_TLS_CA: '', AWP_BROKER_TRUST_FILE: '' },
      encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/AWP_BROKER_TLS/)
  })

  it('gen-dev-pki produces CA-signed broker cert', async () => {
    const { generateDevPki } = await import('../scripts/gen-dev-pki.mjs')
    const { readFileSync } = await import('node:fs')
    const { X509Certificate } = await import('node:crypto')
    const dir = mkdtempSync(join(tmpdir(), 'awp-pki-'))
    const trust = generateDevPki(dir)
    expect(trust.controlPlaneThumbprints[0]).toMatch(/^[a-f0-9]{64}$/)
    const ca = new X509Certificate(readFileSync(join(dir, 'ca.crt')))
    const broker = new X509Certificate(readFileSync(join(dir, 'broker.crt')))
    expect(ca.ca).toBe(true)
    expect(broker.verify(ca.publicKey)).toBe(true)
  })
})
