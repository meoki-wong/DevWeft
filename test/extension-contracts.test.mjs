import { describe, expect, it, vi } from 'vitest'
import { createBlobBackendAdapter, createRunnerBackendAdapter } from '../extensions/adapters.js'
import {
  createExtensionRegistry, EXTENSION_ERROR_CODES, ExtensionError, normalizeExtensionError, validateExtension,
} from '../extensions/contracts.js'
import { genericDesignSource } from '../testing/lanhu-gateway.js'
import { genericGitProvider } from '../testing/remotes.js'
import { exampleDesignSource } from '../examples/extensions/example-design-source.mjs'

describe('extension contracts and stable error semantics', () => {
  it('accepts the generic Git provider and default no-network design source', async () => {
    expect(validateExtension('gitProvider', genericGitProvider).id).toBe('generic')
    expect(genericGitProvider.canonicalizeRemoteUrl('https://github.com/acme/repo.git')).toBe('https://github.com/acme/repo')
    expect(await genericDesignSource.listTools()).toEqual([])
    await expect(genericDesignSource.callTool('anonymous', 'design')).rejects.toMatchObject({ code: 'EXTENSION_OPERATION_UNSUPPORTED' })
    expect(validateExtension('designSource', exampleDesignSource).id).toBe('example-fixture')
    expect(await exampleDesignSource.callTool('contributor', 'example_get_design', { page: 'checkout' }))
      .toMatchObject({ content: 'Public design fixture for checkout.', isError: false, truncated: false })
  })

  it('validates runner/blob shapes and preserves optional capabilities without changing method errors', async () => {
    const runLane = vi.fn(async () => ({ status: 'passed' }))
    const runner = createRunnerBackendAdapter({ id: 'fixture', runLane, capabilities: { units: ['static'] } })
    expect(await runner.runLane()).toEqual({ status: 'passed' })
    expect(runner.capabilities.units).toEqual(['static'])
    const backend = createBlobBackendAdapter('fixture-blob', {
      prepare: vi.fn(async () => ({ uploadId: 'u1' })), writeUpload: vi.fn(async () => ({ ok: true })), contentPath: () => null, isRemote: true,
    })
    expect(backend.id).toBe('fixture-blob')
    expect(backend.isRemote).toBe(true)
    expect(await backend.prepare({})).toEqual({ uploadId: 'u1' })
    expect(() => validateExtension('runnerBackend', { id: 'broken' })).toThrow(/misses: runLane/)
  })

  it('registry rejects duplicate/missing providers with stable codes and maps transient failures as retryable', () => {
    const registry = createExtensionRegistry()
    registry.register('gitProvider', genericGitProvider)
    expect(registry.resolve('gitProvider', 'generic')).toBe(genericGitProvider)
    expect(() => registry.register('gitProvider', genericGitProvider)).toThrow(expect.objectContaining({ code: 'EXTENSION_CONFLICT' }))
    expect(() => registry.resolve('designSource', 'missing')).toThrow(expect.objectContaining({ code: 'EXTENSION_NOT_FOUND' }))
    expect(normalizeExtensionError(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }), 'Git provider'))
      .toMatchObject({ code: 'EXTENSION_UNAVAILABLE', retryable: true })
    expect(normalizeExtensionError(Object.assign(new Error('bad request'), { code: 'INVALID_SCHEMA' })))
      .toMatchObject({ code: 'EXTENSION_REJECTED', retryable: false })
    expect(new ExtensionError('EXTENSION_CONFLICT').code).toBe('EXTENSION_CONFLICT')
    expect(EXTENSION_ERROR_CODES).toContain('EXTENSION_OPERATION_UNSUPPORTED')
  })
})
