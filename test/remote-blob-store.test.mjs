/**
 * remote-blob-store.test.mjs — 备用机远程 blob 上传客户端（testing/blobs.js createRemoteBlobStore）
 *
 * 覆盖：
 *  1. isRemote 标志 + contentPath() 返回 null（createTestSubmission 依赖 isRemote 跳过本地存在性检查）；
 *  2. prepare 走 HTTP POST /v1/blobs:prepare，带 Bearer 认证与 Idempotency-Key 头；
 *  3. writeUpload 走 HTTP PUT，body 为 Uint8Array 且 Content-Length 正确；
 *  4. 非 2xx 响应抛错并携带主机返回的正文（SNAPSHOT_HASH_MISMATCH 明细可见）。
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRemoteBlobStore, createBlobStore } from '../testing/blobs.js'
import { resolveBlobUploadBase, createBlobStoreForEnv } from '../testing/blob-store-env.js'
import { resolveBlobUploadBase as resolveBlobUploadBaseCompat } from '../testing/submit-run.js'

function mkFetch() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/v1/blobs:prepare')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { alreadyExists: false, uploadId: 'u-1', uploadUrl: '/v1/blobs/uploads/u-1' } }),
      }
    }
    if (String(url).includes('/v1/blobs/uploads/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { sha256: 'x'.repeat(64), size: 3 } }),
      }
    }
    return { ok: false, status: 404, text: async () => 'no route' }
  }
  return { fetchImpl, calls }
}

const buf = Buffer.from('abc')

describe('createRemoteBlobStore', () => {
  it('1) isRemote=true 且 contentPath() 返回 null', () => {
    const store = createRemoteBlobStore('http://127.0.0.1:8791', 'tok', { fetchImpl: mkFetch().fetchImpl })
    expect(store.isRemote).toBe(true)
    expect(store.contentPath('a'.repeat(64))).toBe(null)
  })

  it('2) prepare 走 POST /v1/blobs:prepare，带 Bearer 与 Idempotency-Key', async () => {
    const { fetchImpl, calls } = mkFetch()
    const store = createRemoteBlobStore('http://127.0.0.1:8791', 'tok-abc', { fetchImpl })
    const out = await store.prepare({ kind: 'git-bundle', sha256: 'a'.repeat(64), size: 3 })
    expect(out.uploadId).toBe('u-1')
    const c = calls[0]
    expect(c.url).toBe('http://127.0.0.1:8791/v1/blobs:prepare')
    expect(c.init.method).toBe('POST')
    expect(c.init.headers.Authorization).toBe('Bearer tok-abc')
    expect(c.init.headers['Idempotency-Key']).toBeTruthy()
  })

  it('3) writeUpload 走 PUT，body 为 Uint8Array 且 Content-Length 正确', async () => {
    const { fetchImpl, calls } = mkFetch()
    const store = createRemoteBlobStore('http://127.0.0.1:8791', 'tok', { fetchImpl })
    await store.writeUpload('u-1', buf)
    const c = calls[0]
    expect(c.url).toBe('http://127.0.0.1:8791/v1/blobs/uploads/u-1')
    expect(c.init.method).toBe('PUT')
    expect(c.init.headers['Content-Length']).toBe(String(buf.length))
    expect(c.init.body instanceof Uint8Array).toBe(true)
    expect(c.init.body.length).toBe(buf.length)
    expect(createHash('sha256').update(c.init.body).digest('hex'))
      .toBe(createHash('sha256').update(buf).digest('hex'))
  })

  it('4) 非 2xx 抛错并携带主机返回正文（明细可诊断）', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 'SNAPSHOT_HASH_MISMATCH', detail: 'expected sha256=aa size=3, actual sha256=bb size=2' } }),
    })
    const store = createRemoteBlobStore('http://127.0.0.1:8791', 'tok', { fetchImpl })
    await expect(store.writeUpload('u-1', buf)).rejects.toThrow(/SNAPSHOT_HASH_MISMATCH/)
  })
})

describe('resolveBlobUploadBase（备用机上传地址决策）', () => {
  it('1) env AWP_BLOB_BASE_URL 优先（规范名，指独立 blob 服务 8792）', () => {
    expect(resolveBlobUploadBase({ AWP_BLOB_BASE_URL: 'http://127.0.0.1:8792' }, 'http://127.0.0.1:8791'))
      .toBe('http://127.0.0.1:8792')
  })

  it('2) 旧名 AWP_PRIMARY_BASE_URL 兼容，但被规范名覆盖', () => {
    expect(resolveBlobUploadBase({ AWP_PRIMARY_BASE_URL: 'http://127.0.0.1:8791' }, null))
      .toBe('http://127.0.0.1:8791')
    expect(resolveBlobUploadBase({
      AWP_PRIMARY_BASE_URL: 'http://127.0.0.1:8791',
      AWP_BLOB_BASE_URL: 'http://127.0.0.1:8792',
    }, null)).toBe('http://127.0.0.1:8792')
  })

  it('3) 无 env 时 links.primary 非 loopback 才可用；loopback 被剔除', () => {
    expect(resolveBlobUploadBase({}, 'http://127.0.0.1:8791')).toBe('http://127.0.0.1:8791')
    // links 存主机视角地址，在备用机上 127.0.0.1 指备用机自己，必须剔除
    expect(resolveBlobUploadBase({}, 'http://127.0.0.1:8791')).toBe('http://127.0.0.1:8792')
    expect(resolveBlobUploadBase({}, 'http://localhost:8791')).toBe('http://127.0.0.1:8792')
  })

  it('4) 全无配置时默认主机独立 blob 服务 8792（演练停控制面 8791 不受影响）', () => {
    expect(resolveBlobUploadBase({}, null)).toBe('http://127.0.0.1:8792')
    expect(resolveBlobUploadBase({}, '')).toBe('http://127.0.0.1:8792')
  })
})

describe('blob kind 白名单（考卷内容经同通道上传）', () => {
  it('test-spec kind 可 prepare/落盘（备用机提交考卷内容依赖）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awp-blobs-kind-'))
    const store = createBlobStore(dir)
    const content = 'console.log("spec")'
    const sha = createHash('sha256').update(content).digest('hex')
    const prep = store.prepare({ kind: 'test-spec', sha256: sha, size: Buffer.byteLength(content) })
    expect(prep.uploadId).toBeTruthy()
    store.writeUploadBuffer(prep.uploadId, Buffer.from(content))
    // 落盘后同 sha 幂等：alreadyExists
    expect(store.prepare({ kind: 'test-spec', sha256: sha, size: Buffer.byteLength(content) }).alreadyExists).toBe(true)
  })

  it('未登记 kind 仍拒绝（INVALID_SCHEMA）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awp-blobs-kind-'))
    const store = createBlobStore(dir)
    expect(() => store.prepare({ kind: 'random-kind', sha256: 'a'.repeat(64), size: 1 })).toThrow()
  })
})

describe('createBlobStoreForEnv 项目根路径（10-09 token 误报回归）', () => {
  const fakeDb = { prepare: () => ({ get: async () => null }) }
  const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

  it('主机模式：本地存储落在 <项目根>/data/blobs，而不是项目根的上一级', async () => {
    const prev = process.env.AWP_STANDBY
    delete process.env.AWP_STANDBY
    try {
      const store = await createBlobStoreForEnv(fakeDb)
      const expectedRoot = path.join(projectRoot, 'data', 'blobs')
      const p = store.contentPath('a'.repeat(64))
      expect(p.startsWith(expectedRoot)).toBe(true)
      // 回归断言：曾因 '..','..' 把根算到上级，落在 <项目根>/../data/blobs
      expect(p.startsWith(path.join(projectRoot, '..', 'data'))).toBe(false)
    } finally {
      if (prev !== undefined) process.env.AWP_STANDBY = prev
    }
  })

  it('备用机模式：token 读 <repoRoot>/data/bootstrap-admin.token，返回远程存储', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'awp-root-'))
    mkdirSync(path.join(tmpRoot, 'data'), { recursive: true })
    writeFileSync(path.join(tmpRoot, 'data', 'bootstrap-admin.token'), 'tok-123')
    const store = await createBlobStoreForEnv(fakeDb, {
      env: { AWP_STANDBY: '1', AWP_BLOB_BASE_URL: 'http://127.0.0.1:8792' },
      repoRoot: tmpRoot,
    })
    expect(store.isRemote).toBe(true)
  })

  it('备用机模式：repoRoot 下无 token 时抛出与生产一致的错误文案', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'awp-root-'))
    await expect(createBlobStoreForEnv(fakeDb, {
      env: { AWP_STANDBY: '1', AWP_BLOB_BASE_URL: 'http://127.0.0.1:8792' },
      repoRoot: tmpRoot,
    })).rejects.toThrow(/需要 data\/bootstrap-admin\.token/)
  })

  it('submit-run re-export 保持兼容（同一函数）', () => {
    expect(resolveBlobUploadBaseCompat).toBe(resolveBlobUploadBase)
  })
})
