import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONTRACT_FILE_NAMES,
  CONTRACT_VERSION,
  RUNSPEC_AUDIENCE,
  SCHEMA_VERSION,
  bindingIdFromDocument,
  canonicalize,
  contractChecksum,
  documentSha256,
} from '../contracts/version.mjs'
import { assertInvalid, assertValid } from './helpers/schema-assert.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
const contractsDir = join(dir, '..', 'contracts')

function loadJson(name) {
  return JSON.parse(readFileSync(join(contractsDir, name), 'utf8'))
}

function errorCodesFromMarkdown(text) {
  return [...text.matchAll(/\| `([A-Z][A-Z0-9_]*)` \| (\d+) \|/g)].map((m) => m[1])
}

const SHA = 'a'.repeat(64)
const OID = 'b'.repeat(40)
const UUID = '018f0000-0000-7000-8000-000000000001'
const UUID2 = '018f0000-0000-7000-8000-000000000002'

function sampleBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    repoId: UUID,
    sourceRemoteId: UUID2,
    branchIncarnationId: UUID,
    taskInstanceId: UUID2,
    headCommitOid: OID,
    snapshotTreeOid: OID,
    changedPathsSha256: SHA,
    targetRemoteId: UUID,
    targetRef: 'refs/heads/stage',
    targetCommitOid: OID,
    suiteLockSha256: SHA,
    effectiveSuiteTreeOid: OID,
    executionProfileRevisionId: UUID,
    runnerImageId: 'win2025-pw-node22-20260903.1',
    runnerImageManifestSha256: SHA,
    policyRevisionId: UUID2,
    resolvedSides: ['web'],
    requiredCaseSetSha256: SHA,
    ...overrides,
  }
}

function sampleRunSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: UUID,
    attempt: 1,
    leaseEpoch: 1,
    bindingId: SHA,
    sourceBlobSha256: SHA,
    suiteLockSha256: SHA,
    suiteBlobSha256: SHA,
    profileRevisionId: UUID,
    policyRevisionId: UUID2,
    runnerImageId: 'win2025-pw-node22-20260903.1',
    runnerImageManifestSha256: SHA,
    unit: 'static',
    side: 'na',
    purpose: 'gate',
    resourceLimits: { vcpu: 4, memoryGiB: 8 },
    timeouts: {
      provisionSeconds: 300,
      installSeconds: 900,
      staticSeconds: 600,
      viteReadySeconds: 120,
      smokeSeconds: 720,
      artifactSeconds: 300,
      totalSeconds: 2400,
    },
    networkPolicyId: 'npm-proxy-only-v1',
    secretRefs: ['npm-readonly-v1'],
    nonce: 'n'.repeat(24),
    issuedAt: '2026-09-03T08:00:00.000Z',
    expiresAt: '2026-09-03T08:45:00.000Z',
    audience: RUNSPEC_AUDIENCE,
    guestPublicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA' + 'A'.repeat(32) + '\n-----END PUBLIC KEY-----',
    guestKeySha256: SHA,
    ...overrides,
  }
}

describe('M0 contracts', () => {
  it('lists the frozen contract files', () => {
    for (const name of CONTRACT_FILE_NAMES) {
      readFileSync(join(contractsDir, name))
    }
    expect(CONTRACT_VERSION).toBe('1.1.0')
    expect(SCHEMA_VERSION).toBe(1)
    expect(contractChecksum()).toMatch(/^[a-f0-9]{64}$/)
  })

  it('CLRP remediation packet schema accepts sample', () => {
    const schema = loadJson('remediation-packet.schema.json')
    const sample = {
      protocol: 'CLRP/1',
      taskId: 'T1',
      repo: 'demo-app',
      status: 'failed',
      loop: {
        state: 'remediation_suite',
        iteration: 1,
        maxIterations: 5,
        canRetry: true,
        nextAllowed: ['fix_spec', 'distill', 'resubmit'],
      },
      classification: { overall: 'suite', byCheck: [] },
      actions: [{ tool: 'awp_test_spec_get', args: { featureKey: 'x' }, required: true }],
      forbidden: ['宣称任务完成'],
      completionBlocked: true,
    }
    assertValid(schema, sample)
  })

  it('I01 same canonical binding hashes identically', () => {
    const schema = loadJson('binding.schema.json')
    const a = sampleBinding()
    const b = sampleBinding()
    assertValid(schema, a)
    expect(canonicalize(a)).toBe(canonicalize(b))
    expect(bindingIdFromDocument(a)).toBe(bindingIdFromDocument(b))
    expect(documentSha256({ z: 1, a: 2 })).toBe(documentSha256({ a: 2, z: 1 }))
  })

  it('I02 one-byte snapshot tree change produces a new binding_id', () => {
    const a = sampleBinding()
    const b = sampleBinding({ snapshotTreeOid: 'c'.repeat(40) })
    expect(bindingIdFromDocument(a)).not.toBe(bindingIdFromDocument(b))
  })

  it('rejects unknown binding fields and omitted nullables', () => {
    const schema = loadJson('binding.schema.json')
    assertInvalid(schema, sampleBinding({ extra: true }))
    const missing = sampleBinding()
    delete missing.branchIncarnationId
    assertInvalid(schema, missing)
    assertValid(schema, sampleBinding({ branchIncarnationId: null }))
  })

  it('forbids floats in canonical JSON', () => {
    expect(() => canonicalize({ n: 1.5 })).toThrow(/float/)
  })

  it('validates RunSpec and rejects wrong audience', () => {
    const schema = loadJson('run-spec.schema.json')
    assertValid(schema, sampleRunSpec())
    assertInvalid(schema, sampleRunSpec({ audience: 'other' }))
    assertInvalid(schema, sampleRunSpec({ resourceLimits: { vcpu: 8, memoryGiB: 8 } }))
  })

  it('validates result.json and suite manifest', () => {
    const report = loadJson('test-report.schema.json')
    assertValid(report, {
      schemaVersion: 1,
      runId: UUID,
      attempt: 1,
      leaseEpoch: 7,
      bindingId: SHA,
      status: 'passed',
      checks: [{ caseKey: 'test:static/eslint', status: 'passed', durationMs: 12 }],
    })
    const manifest = loadJson('suite-manifest.schema.json')
    assertValid(manifest, {
      schemaVersion: 1,
      title: 'project-static',
      requiredCapabilities: [],
      cases: [
        {
          caseKey: 'test:static/eslint',
          title: 'readonly eslint',
          tags: ['static'],
          protected: true,
          replacesCaseKey: null,
          requiredCapabilities: [],
        },
      ],
    })
  })

  it('rejects artifact paths that escape with ..', () => {
    const report = loadJson('test-report.schema.json')
    const manifestSchema = report.$defs.artifactSidecarManifest
    const good = {
      schemaVersion: 1,
      runId: UUID,
      attempt: 1,
      leaseEpoch: 1,
      bindingId: SHA,
      sourceSha256: SHA,
      suiteLockSha256: SHA,
      imageId: 'win2025-pw-node22-20260903.1',
      imageManifestSha256: SHA,
      resultSha256: SHA,
      archiveSha256: SHA,
      files: [{ path: 'junit.xml', sha256: SHA, size: 10 }],
      totalSize: 10,
      artifactTruncated: false,
    }
    assertValid(manifestSchema, good, report)
    assertInvalid(manifestSchema, {
      ...good,
      files: [{ path: '../secret.txt', sha256: SHA, size: 1 }],
    }, report)
  })

  it('keeps error codes in sync across errors.md, OpenAPI and §17', () => {
    const errorsMd = readFileSync(join(contractsDir, 'errors.md'), 'utf8')
    const openapi = readFileSync(join(contractsDir, 'testing-openapi.yaml'), 'utf8')
    const enterprise = readFileSync(join(dir, '..', 'docs', 'TEST-PLATFORM-ENTERPRISE.md'), 'utf8')
    const fromMd = errorCodesFromMarkdown(errorsMd)
    expect(fromMd.length).toBeGreaterThan(30)
    const enumBlock = openapi.split('ErrorCode:')[1].split('ErrorObject:')[0]
    const fromOpenApi = [...enumBlock.matchAll(/- ([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])
    expect([...fromOpenApi].sort()).toEqual([...fromMd].sort())
    for (const code of fromMd) {
      expect(enterprise).toContain('`' + code + '`')
    }
  })

  it('OpenAPI lists frozen control-plane and broker paths', () => {
    const openapi = readFileSync(join(contractsDir, 'testing-openapi.yaml'), 'utf8')
    for (const p of [
      '/git-contexts:resolve',
      '/test-submissions',
      '/gates:evaluate',
      '/runner/leases:acquire',
      '/runner/leases/{leaseId}:accept',
      '/grants',
      '/grants/{secretGrantId}:fetch',
      '/grants/{secretGrantId}:revoke',
      '/test-specs',
    ]) {
      expect(openapi).toContain(p)
    }
  })
})
