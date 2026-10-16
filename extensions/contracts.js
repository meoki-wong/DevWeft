/** Stable provider seams for optional integrations. Providers never receive more data than their method input. */
export const EXTENSION_ERROR_CODES = Object.freeze([
  'EXTENSION_NOT_FOUND', 'EXTENSION_INVALID', 'EXTENSION_OPERATION_UNSUPPORTED',
  'EXTENSION_UNAVAILABLE', 'EXTENSION_CONFLICT', 'EXTENSION_REJECTED', 'EXTENSION_FAILED',
])

const CONTRACTS = Object.freeze({
  gitProvider: ['canonicalizeRemoteUrl', 'remoteUrlFingerprint', 'resolveContext'],
  designSource: ['listTools', 'callTool'],
  runnerBackend: ['runLane'],
  blobBackend: ['prepare', 'writeUpload', 'contentPath'],
})

export class ExtensionError extends Error {
  constructor(code, message = code, { retryable = false, cause = null } = {}) {
    if (!EXTENSION_ERROR_CODES.includes(code)) throw new TypeError(`Unknown extension error code: ${code}`)
    super(message, cause ? { cause } : undefined)
    this.name = 'ExtensionError'
    this.code = code
    this.retryable = Boolean(retryable)
  }
}

export function validateExtension(kind, adapter) {
  const methods = CONTRACTS[kind]
  if (!methods) throw new ExtensionError('EXTENSION_INVALID', `Unknown extension kind: ${kind}`)
  if (!adapter || typeof adapter !== 'object' || !adapter.id || typeof adapter.id !== 'string') {
    throw new ExtensionError('EXTENSION_INVALID', `${kind} extension must provide a string id`)
  }
  const missing = methods.filter((method) => typeof adapter[method] !== 'function')
  if (missing.length) throw new ExtensionError('EXTENSION_INVALID', `${kind} extension ${adapter.id} misses: ${missing.join(', ')}`)
  return adapter
}

export function createExtensionRegistry() {
  const entries = new Map(Object.keys(CONTRACTS).map((kind) => [kind, new Map()]))
  return Object.freeze({
    register(kind, adapter) {
      validateExtension(kind, adapter)
      const providers = entries.get(kind)
      if (providers.has(adapter.id)) throw new ExtensionError('EXTENSION_CONFLICT', `${kind} extension already registered: ${adapter.id}`)
      providers.set(adapter.id, adapter)
      return adapter
    },
    resolve(kind, id) {
      const provider = entries.get(kind)?.get(String(id || ''))
      if (!provider) throw new ExtensionError('EXTENSION_NOT_FOUND', `${kind} extension not found: ${id || '(empty)'}`)
      return provider
    },
    list(kind) {
      const providers = entries.get(kind)
      if (!providers) throw new ExtensionError('EXTENSION_INVALID', `Unknown extension kind: ${kind}`)
      return [...providers.values()]
    },
  })
}

export function normalizeExtensionError(error, operation = 'extension operation') {
  if (error instanceof ExtensionError) return error
  const original = String(error?.code || error?.cause?.code || '')
  const unavailable = new Set(['BLOB_STORE_UNAVAILABLE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])
  const code = unavailable.has(original) ? 'EXTENSION_UNAVAILABLE'
    : ['UNRESOLVED_REMOTE', 'NOT_FOUND'].includes(original) ? 'EXTENSION_NOT_FOUND'
      : ['INVALID_SCHEMA', 'LANHU_TOOL_FORBIDDEN'].includes(original) ? 'EXTENSION_REJECTED'
        : 'EXTENSION_FAILED'
  return new ExtensionError(code, `${operation} failed (${code})`, { retryable: code === 'EXTENSION_UNAVAILABLE', cause: error })
}

export const EXTENSION_CONTRACTS = CONTRACTS
