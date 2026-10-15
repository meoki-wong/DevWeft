/**
 * runner/blob-store/server.mjs — 独立 blob 上传常驻服务（主机，pm2 承载，默认 8792）。
 *
 * 为什么独立成进程：blob 上传通道原先挂在控制面（server.js 8791）上，而控制面是最常被
 * 「停机演练主备切换 / 重启发版」的进程——主备切换演练时停掉主机控制面，备用链路的
 * awp_test_run 就会在 bundle 上传环节断掉（fetch failed），演练被迫中断。
 * 剥离后：备用机下单链路只依赖 本服务 + PostgreSQL + host-worker，控制面随便停。
 *
 * 职责（与控制面完全同构，路由单一真源 testing/routes.js mountBlobRoutes）：
 *   POST /v1/blobs:prepare            预约上传（认证：Bearer principal_tokens）
 *   PUT  /v1/blobs/uploads/:uploadId  流式写盘 + sha256/size 强校验（fail-closed）
 *   GET  /api/health/live             存活探针
 *
 * 不连库则拒绝服务（认证依赖 PG principal_tokens）；不依赖控制面/gateway/worker。
 */
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import db, { openDb, DB_DIALECT } from '../../db.js'
import { createBlobStore } from '../../testing/blobs.js'
import { mountBlobRoutes } from '../../testing/routes.js'
import { randomUUID } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

// postgres：结构由 baseline.sql 负责，仅连接（与 server.js / worker-service 同约定）
if (DB_DIALECT === 'sqlite') {
  console.error('[blob-store] 仅支持 postgres 部署（独立服务跑在主机）')
  process.exit(2)
}
await openDb()

const PORT = Number(process.env.PORT || process.env.AWP_BLOB_PORT || 8792)
const app = express()

// 与控制面同构（server.js express.json 50mb）：JSON 请求解析入 req.body；
// PUT octet-stream 不解析、流原样留给 writeUploadStream 消费（express.json 按 content-type 分流）。
app.use(express.json({ limit: '50mb' }))

// 与 mountTestingRoutes 同款请求 ID 中间件（mountBlobRoutes 依赖 req.awpRequestId）
app.use('/v1', (req, res, next) => {
  req.awpRequestId = randomUUID()
  res.setHeader('X-Request-Id', req.awpRequestId)
  next()
})

app.get('/api/health/live', (_req, res) => {
  res.json({ ok: true, service: 'blob-store' })
})

const blobs = createBlobStore(process.env.AWP_BLOB_ROOT || path.join(root, 'data', 'blobs'))
mountBlobRoutes(app, { database: db, blobs })

app.listen(PORT, () => {
  console.log(`[blob-store] listening on http://0.0.0.0:${PORT}`)
  console.log('[blob-store] routes: POST /v1/blobs:prepare | PUT /v1/blobs/uploads/:uploadId | GET /api/health/live')
})
