import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { ApiError, rejectUnknownFields } from './errors.js'
import { utcNow } from './ids.js'

/**
 * 远程 blob 存储客户端：备用机通过 HTTP 上传 bundle 到主机的 blob 存储。
 * 解决备用机提交云端测试时 bundle 落在备用机本地、主机 worker 找不到的问题。
 */
export function createRemoteBlobStore(baseUrl, token, { fetchImpl = globalThis.fetch } = {}) {
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '')
  if (!normalizedBase) throw new Error('createRemoteBlobStore: baseUrl required')

  async function request(url, init) {
    let res
    try {
      res = await fetchImpl(url, init)
    } catch {
      throw new ApiError('BLOB_STORE_UNAVAILABLE')
    }
    if (!res.ok) {
      let body = null
      try { body = await res.json() } catch { /* response may not be JSON */ }
      const remoteError = body?.error
      if (remoteError?.code === 'SNAPSHOT_HASH_MISMATCH') {
        throw new ApiError('SNAPSHOT_HASH_MISMATCH', { detail: remoteError.detail })
      }
      if (res.status >= 500 || res.status === 408 || res.status === 429) {
        throw new ApiError('BLOB_STORE_UNAVAILABLE')
      }
      throw new Error(`remote blob request rejected (HTTP ${res.status})`)
    }
    try {
      return await res.json()
    } catch {
      throw new ApiError('BLOB_STORE_UNAVAILABLE')
    }
  }

  async function prepare(body) {
    rejectUnknownFields(body, ['kind', 'sha256', 'size'])
    const json = await request(`${normalizedBase}/v1/blobs:prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    })
    return json.data || json
  }

  async function writeUpload(uploadId, buffer) {
    // Node.js fetch 需要 Uint8Array/ArrayBuffer，Buffer 是 Uint8Array 的子类但某些实现可能处理不当
    // 显式转换并设置 Content-Length 确保主机正确接收完整数据
    const bodyBytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const json = await request(`${normalizedBase}/v1/blobs/uploads/${uploadId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bodyBytes.length),
        Authorization: `Bearer ${token}`,
      },
      body: bodyBytes,
      duplex: 'half', // Node.js fetch 上传 body 时需要
    })
    return json.data || json
  }

  // contentPath 在远程模式下无意义（bundle 不在本机），返回 null 让调用方知道
  function contentPath() {
    return null
  }

  return { prepare, writeUpload, writeUploadBuffer: writeUpload, contentPath, isRemote: true }
}

export function createBlobStore(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true })
  const uploadRoot = path.join(rootDir, 'uploads')
  const blobRoot = path.join(rootDir, 'sha256')
  fs.mkdirSync(uploadRoot, { recursive: true })
  fs.mkdirSync(blobRoot, { recursive: true })

  function contentPath(sha256) {
    return path.join(blobRoot, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  }

  function prepare(body, { expiresAt } = {}) {
    rejectUnknownFields(body, ['kind', 'sha256', 'size'])
    if (!['git-bundle', 'suite-blob', 'candidate-blob', 'run-artifact', 'scanner-report', 'test-spec'].includes(body.kind)) throw new ApiError('INVALID_SCHEMA')
    if (!/^[a-f0-9]{64}$/.test(body.sha256)) throw new ApiError('INVALID_SCHEMA')
    if (!Number.isInteger(body.size) || body.size < 1) throw new ApiError('INVALID_SCHEMA')
    const dest = contentPath(body.sha256)
    if (fs.existsSync(dest) && fs.statSync(dest).size === body.size) {
      return { alreadyExists: true, uploadId: null, uploadUrl: null, expiresAt: null }
    }
    const uploadId = randomUUID()
    const meta = {
      uploadId,
      kind: body.kind,
      sha256: body.sha256,
      size: body.size,
      expiresAt: expiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAt: utcNow(),
    }
    fs.writeFileSync(path.join(uploadRoot, `${uploadId}.json`), JSON.stringify(meta))
    return {
      alreadyExists: false,
      uploadId,
      uploadUrl: `/v1/blobs/uploads/${uploadId}`,
      expiresAt: meta.expiresAt,
    }
  }

  function finishUpload(meta, tmp, digest, size) {
    if (size !== meta.size || digest !== meta.sha256) {
      fs.rmSync(tmp, { force: true })
      // 改进错误信息：返回 expected vs actual 的 sha256 和 size，便于诊断是「工作区脏区残留」还是「镜像落后」
      const detail = `expected sha256=${meta.sha256} size=${meta.size}, actual sha256=${digest} size=${size}`
      throw new ApiError('SNAPSHOT_HASH_MISMATCH', { detail })
    }
    const dest = contentPath(meta.sha256)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (!fs.existsSync(dest)) fs.renameSync(tmp, dest)
    else fs.rmSync(tmp, { force: true })
    fs.rmSync(path.join(uploadRoot, `${meta.uploadId}.json`), { force: true })
    return { sha256: meta.sha256, size: meta.size }
  }

  function writeUploadStream(uploadId, readable) {
    const metaPath = path.join(uploadRoot, `${uploadId}.json`)
    if (!fs.existsSync(metaPath)) throw new ApiError('INVALID_SCHEMA')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    if (Date.parse(meta.expiresAt) <= Date.now()) throw new ApiError('INVALID_SCHEMA')
    const tmp = path.join(uploadRoot, `${uploadId}.part`)
    const hash = createHash('sha256')
    let size = 0
    const ws = fs.createWriteStream(tmp)
    return new Promise((resolve, reject) => {
      let done = false
      const fail = (err) => {
        if (done) return
        done = true
        readable.destroy?.()
        ws.destroy()
        fs.rmSync(tmp, { force: true })
        reject(err)
      }
      readable.on('error', fail)
      ws.on('error', fail)
      readable.on('data', (chunk) => {
        size += chunk.length
        if (size > meta.size) {
          fail(new ApiError('SNAPSHOT_HASH_MISMATCH'))
          return
        }
        hash.update(chunk)
        if (!ws.write(chunk)) readable.pause()
      })
      ws.on('drain', () => readable.resume())
      readable.on('end', () => ws.end())
      ws.on('finish', () => {
        if (done) return
        try {
          const digest = hash.digest('hex')
          const result = finishUpload(meta, tmp, digest, size)
          done = true
          resolve(result)
        } catch (err) {
          fail(err)
        }
      })
    })
  }

  function writeUpload(uploadId, streamOrBuffer) {
    if (Buffer.isBuffer(streamOrBuffer) || typeof streamOrBuffer === 'string') {
      return writeUploadStream(uploadId, Readable.from(Buffer.from(streamOrBuffer)))
    }
    return writeUploadStream(uploadId, streamOrBuffer)
  }

  function writeUploadBuffer(uploadId, buffer) {
    const metaPath = path.join(uploadRoot, `${uploadId}.json`)
    if (!fs.existsSync(metaPath)) throw new ApiError('INVALID_SCHEMA')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    if (Date.parse(meta.expiresAt) <= Date.now()) throw new ApiError('INVALID_SCHEMA')
    const digest = createHash('sha256').update(buffer).digest('hex')
    const tmp = path.join(uploadRoot, `${uploadId}.part`)
    fs.writeFileSync(tmp, buffer)
    return finishUpload(meta, tmp, digest, buffer.length)
  }

  return { prepare, writeUpload, writeUploadStream, writeUploadBuffer, contentPath }
}
