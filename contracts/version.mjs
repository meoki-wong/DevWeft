/**
 * 测试平台契约版本与 canonical JSON（§6.3 / §14.8）。
 * 禁止浮点数；key 递归字典序；UTF-8；无空白。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOCUMENT_ID = 'AWP-TEST-PLATFORM'
export const DOCUMENT_VERSION = '3.0.0-draft'
export const CONTRACT_VERSION = '1.1.0'
export const SCHEMA_VERSION = 1
export const CLRP_PROTOCOL = 'CLRP/1'
export const RUNSPEC_AUDIENCE = 'awp-guest-agent'
export const SNAPSHOT_COMMIT_IDENTITY = 'AWP Test Snapshot <noreply@agent-workflow.invalid>'
export const SNAPSHOT_COMMIT_MESSAGE = 'awp-test snapshot v1'

export const CONTRACT_FILE_NAMES = Object.freeze([
  'testing-openapi.yaml',
  'test-report.schema.json',
  'run-spec.schema.json',
  'suite-manifest.schema.json',
  'binding.schema.json',
  'remediation-packet.schema.json',
  'errors.md',
  'version.mjs',
])

const dir = dirname(fileURLToPath(import.meta.url))

export function canonicalize(value) {
  return serialize(value)
}

function serialize(value) {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  const t = typeof value
  if (t === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new TypeError('canonical JSON forbids floats and non-safe integers')
    }
    return String(value)
  }
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`
  }
  if (t === 'object') {
    // JCS 语义：undefined 不是合法 JSON 值，剔除该键（与 JSON.stringify 一致）。
    // 不剔除则 smoke passed 场景（detail 缺省）签发 result 时抛 TypeError（9/8 第十六轮实冟）
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k])}`).join(',')}}`
  }
  throw new TypeError(`unsupported canonical JSON type: ${t}`)
}

export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  return createHash('sha256').update(buf).digest('hex')
}

export function documentSha256(value) {
  return sha256Hex(canonicalize(value))
}

export function bindingIdFromDocument(doc) {
  if (doc == null || doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('binding schemaVersion mismatch')
  }
  return documentSha256(doc)
}

export function contractChecksum() {
  const hash = createHash('sha256')
  for (const name of CONTRACT_FILE_NAMES) {
    hash.update(name)
    hash.update('\0')
    hash.update(readFileSync(join(dir, name)))
    hash.update('\0')
  }
  return hash.digest('hex')
}
