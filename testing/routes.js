import path from 'node:path'
import { existsSync, createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import db from '../db.js'
import { authenticateBearer, requireRepoPermission } from './auth.js'
import { getBinding } from './bindings.js'
import { createBlobStore } from './blobs.js'
import { envelope, sendError, ApiError } from './errors.js'
import { rememberIdempotency } from './idempotency.js'
import { resolveGitContext } from './remotes.js'
import { createTestSubmission, getTestSubmission } from './submissions.js'
import { submitTestSpec, getTestSpec, activeSpecsForRepo } from './test-specs.js'
import { previewSuitePlan } from './suite-plan.js'
import { authenticateWorker, acquireLease, acceptLease, heartbeatLease, completeLease, rejectLease } from './leases.js'
import { evaluateNewGate } from '../harness/testing-gate.js'
import {
  prepareRunArtifact, markArtifactUploaded, issueArtifactDownloadUrl, consumeArtifactDownload,
} from './artifacts.js'
import { randomUUID } from 'node:crypto'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let workerTlsRequired = false

/**
 * blob 上传路由（POST /v1/blobs:prepare + PUT /v1/blobs/uploads/:uploadId）。
 * 单一真源：控制面（mountTestingRoutes）与独立 blob 服务（runner/blob-store/server.mjs）共用。
 * 独立服务存在的意义：主备切换演练/控制面重启时 blob 上传通道不中断
 * （备用机下单链路只依赖本路由 + host-worker，不依赖控制面进程）。
 */
export function mountBlobRoutes(app, { database = db, blobs }) {
  app.post('/v1/blobs:prepare', async (req, res) => {
    try {
      await authenticateBearer(database, req.headers.authorization)
      const key = req.headers['idempotency-key']
      if (!key) throw new ApiError('INVALID_SCHEMA')
      const data = blobs.prepare(req.body || {})
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.put('/v1/blobs/uploads/:uploadId', async (req, res) => {
    try {
      await authenticateBearer(database, req.headers.authorization)
      blobs.writeUploadStream(req.params.uploadId, req).then(
        (data) => res.json(envelope(data, null, req.awpRequestId)),
        (err) => sendError(res, err, req.awpRequestId)
      )
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })
}

export function mountTestingRoutes(app, { database = db, blobRoot, tlsRequired = false } = {}) {
  const blobs = createBlobStore(blobRoot || path.join(root, 'data', 'blobs'))
  workerTlsRequired = Boolean(tlsRequired)

  app.use('/v1', (req, res, next) => {
    req.awpRequestId = randomUUID()
    res.setHeader('X-Request-Id', req.awpRequestId)
    next()
  })

  app.post('/v1/git-contexts:resolve', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const data = await resolveGitContext(database, req.body || {})
      requireRepoPermission(principal, data.repoId, 'submit')
      const key = req.headers['idempotency-key']
      if (!key) throw new ApiError('INVALID_SCHEMA')
      const remembered = await rememberIdempotency(database, {
        principalId: principal.principalId,
        repoId: data.repoId,
        route: 'POST /v1/git-contexts:resolve',
        idempotencyKey: String(key),
        requestBody: req.body,
        produce: async () => ({ status: 200, json: envelope(data, null, req.awpRequestId) }),
      })
      res.status(remembered.status).json(remembered.json)
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  mountBlobRoutes(app, { database, blobs })

  app.get('/v1/test-bindings/:bindingId', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const data = await getBinding(database, req.params.bindingId)
      requireRepoPermission(principal, data.document.repoId, 'read_result')
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/suite-plans:resolve', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const key = req.headers['idempotency-key']
      if (!key) throw new ApiError('INVALID_SCHEMA')
      requireRepoPermission(principal, req.body?.repoId, 'submit')
      const remembered = await rememberIdempotency(database, {
        principalId: principal.principalId,
        repoId: req.body?.repoId,
        route: 'POST /v1/suite-plans:resolve',
        idempotencyKey: String(key),
        requestBody: req.body,
        produce: async () => {
          const data = await previewSuitePlan(database, req.body || {})
          return { status: 200, json: envelope(data, null, req.awpRequestId) }
        },
      })
      res.status(remembered.status).json(remembered.json)
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/test-submissions', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const key = req.headers['idempotency-key']
      if (!key) throw new ApiError('INVALID_SCHEMA')
      requireRepoPermission(principal, req.body?.repoId, 'submit')
      const remembered = await rememberIdempotency(database, {
        principalId: principal.principalId,
        repoId: req.body?.repoId,
        route: 'POST /v1/test-submissions',
        idempotencyKey: String(key),
        requestBody: req.body,
        produce: async () => {
          const data = await createTestSubmission(database, blobs, req.body || {}, principal)
          return { status: 200, json: envelope(data, null, req.awpRequestId) }
        },
      })
      res.status(remembered.status).json(remembered.json)
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.get('/v1/test-submissions/:submissionId', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const data = await getTestSubmission(database, req.params.submissionId)
      requireRepoPermission(principal, data.repoId || await lookupRepo(database, data), 'read_result')
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  // ── 测试资产库（feature-key 模式，AI coding 通过 MCP 工具读写）──

  // 提交（创建或修订）测试资产：同 featureKey 内容变化自动 version+1，旧版 archived
  app.post('/v1/test-specs', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const body = req.body || {}
      const repoId = body.repoId || DEFAULT_REPO
      requireRepoPermission(principal, repoId, 'submit')
      const spec = await submitTestSpec({
        repoId,
        featureKey: body.featureKey,
        featureTitle: body.featureTitle,
        demandRef: body.demandRef,
        author: body.author || principal.principalId,
        specType: body.specType,
        codeCommitOid: body.codeCommitOid,
        content: body.content,
      })
      res.status(201).json(envelope(spec, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  // 查询资产（默认最新版，含内容）；?version= 取历史版本
  app.get('/v1/test-specs/:featureKey', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const repoId = req.query.repoId
      if (!repoId) throw new ApiError('INVALID_SCHEMA')
      const spec = await getTestSpec({ repoId, featureKey: req.params.featureKey, version: req.query.version ? Number(req.query.version) : null })
      requireRepoPermission(principal, spec.repo_id, 'read_result')
      res.json(envelope(spec, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  // 执行注入清单（runner 侧拉取全部 active 资产内容）
  app.get('/v1/test-specs-active', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const data = await activeSpecsForRepo(req.query.repoId)
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/runner/leases:acquire', async (req, res) => {
    try {
      const worker = await workerFromRequest(database, req)
      const data = await acquireLease(database, worker)
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/runner/leases/:leaseId\\:accept', async (req, res) => {
    try {
      const worker = await workerFromRequest(database, req)
      const data = await acceptLease(database, worker, req.params.leaseId, req.body || {})
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/runner/leases/:leaseId\\:heartbeat', async (req, res) => {
    try {
      const worker = await workerFromRequest(database, req)
      const data = await heartbeatLease(database, worker, req.params.leaseId, req.body || {})
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/runner/leases/:leaseId\\:complete', async (req, res) => {
    try {
      const worker = await workerFromRequest(database, req)
      const data = await completeLease(database, worker, req.params.leaseId, req.body || {})
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/runner/leases/:leaseId\\:reject', async (req, res) => {
    try {
      const worker = await workerFromRequest(database, req)
      const data = await rejectLease(database, worker, req.params.leaseId, req.body || {})
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/runner/leases/:leaseId/artifact\\:prepare', async (req, res) => {
    try {
      const worker = await workerFromRequest(database, req)
      const data = await prepareRunArtifact(database, blobs, worker, req.params.leaseId, req.body || {})
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.put('/v1/runner/artifact-uploads/:uploadId', async (req, res) => {
    try {
      const worker = await workerFromRequest(database, req)
      blobs.writeUploadStream(req.params.uploadId, req).then(
        async (uploaded) => {
          try {
            await markArtifactUploaded(database, blobs, worker, {
              archiveSha256: uploaded.sha256,
              size: uploaded.size,
            })
            res.json(envelope({ sha256: uploaded.sha256, size: uploaded.size }, null, req.awpRequestId))
          } catch (err) {
            sendError(res, err, req.awpRequestId)
          }
        },
        (err) => sendError(res, err, req.awpRequestId)
      )
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.get('/v1/test-runs/:runId/artifact', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const row = await database.prepare(
        'SELECT * FROM artifacts WHERE run_id=? ORDER BY attempt DESC LIMIT 1'
      ).get(req.params.runId)
      if (!row) throw new ApiError('INVALID_SCHEMA')
      const data = issueArtifactDownloadUrl(database, { artifact: row, principal })
      res.json(envelope(data, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.get('/v1/test-runs/:runId/artifact/content', async (req, res) => {
    try {
      const row = await consumeArtifactDownload(database, {
        runId: req.params.runId,
        token: String(req.query.token || ''),
      })
      const contentPath = blobs.contentPath(row.archive_sha256)
      if (!existsSync(contentPath)) throw new ApiError('ARTIFACT_HASH_MISMATCH')
      res.setHeader('content-type', 'application/zip')
      res.setHeader('content-length', String(row.size))
      res.setHeader('content-disposition', `attachment; filename="artifact-${row.artifact_id}.zip"`)
      createReadStream(contentPath).pipe(res)
    } catch (err) {
      if (!res.headersSent) sendError(res, err, req.awpRequestId)
    }
  })

  // ─── 契约补齐（OpenAPI 对账）：单 run / 组查询、提交取消、门禁预评估 ───

  app.get('/v1/test-runs/:runId', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const row = await database.prepare('SELECT * FROM test_runs WHERE run_id=?').get(req.params.runId)
      if (!row) throw new ApiError('INVALID_SCHEMA')
      requireRepoPermission(principal, row.repo_id, 'read_result')
      const { report_json, payload_json, ...rest } = row
      res.json(envelope({ ...rest, has_report: Boolean(report_json) }, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.get('/v1/test-runs/:runId/report', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const row = await database.prepare('SELECT report_json, repo_id FROM test_runs WHERE run_id=?').get(req.params.runId)
      if (!row || !row.report_json) throw new ApiError('INVALID_SCHEMA')
      requireRepoPermission(principal, row.repo_id, 'read_result')
      res.json(envelope(JSON.parse(row.report_json), null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.get('/v1/run-groups/:runGroupId', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const group = await database.prepare('SELECT * FROM run_groups WHERE run_group_id=?').get(req.params.runGroupId)
      if (!group) throw new ApiError('INVALID_SCHEMA')
      requireRepoPermission(principal, group.repo_id, 'read_result')
      const runs = await database.prepare(
        'SELECT run_id, unit, side, purpose, status, terminal_reason, coverage_complete, created_at, finished_at FROM test_runs WHERE run_group_id=? ORDER BY unit, side'
      ).all(group.run_group_id)
      res.json(envelope({ ...group, runs }, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/test-submissions/:submissionId\\:cancel', async (req, res) => {
    try {
      const principal = await authenticateBearer(database, req.headers.authorization)
      const sub = await database.prepare('SELECT * FROM test_submissions WHERE submission_id=?').get(req.params.submissionId)
      if (!sub) throw new ApiError('INVALID_SCHEMA')
      requireRepoPermission(principal, sub.repo_id, 'submit')
      const info = await database.prepare(
        `UPDATE test_runs SET desired_state='canceled'
         WHERE run_group_id IN (SELECT run_group_id FROM run_groups WHERE submission_id=?)
           AND status IN ('queued','active')`
      ).run(sub.submission_id)
      res.json(envelope({ submissionId: sub.submission_id, canceled: info.changes }, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })

  app.post('/v1/gates\\:evaluate', async (req, res) => {
    try {
      await authenticateBearer(database, req.headers.authorization)
      const body = req.body || {}
      const result = await evaluateNewGate(database, {
        repoSlug: String(body.repoSlug || ''),
        taskId: String(body.taskId || ''),
        size: body.size || 'M',
        gateBindingId: body.gateBindingId || null,
        expectedTaskRevision: body.expectedTaskRevision ?? null,
      })
      res.json(envelope(result, null, req.awpRequestId))
    } catch (err) {
      sendError(res, err, req.awpRequestId)
    }
  })
}

async function workerFromRequest(database, req) {
  // §14.8：mTLS 部署下只认客户端证书指纹；明文 dev 模式才允许 header 回退
  const cert = req.socket?.getPeerCertificate?.()
  const certThumb = cert && cert.fingerprint256 ? cert.fingerprint256 : null
  if (certThumb) {
    return await authenticateWorker(database, {
      workerId: req.headers['x-worker-id'],
      certificateThumbprint: certThumb,
    })
  }
  if (workerTlsRequired) throw new ApiError('CROSS_REPO_REFERENCE')
  return await authenticateWorker(database, {
    workerId: req.headers['x-worker-id'],
    certificateThumbprint: req.headers['x-worker-cert-thumbprint'],
  })
}

async function lookupRepo(database, data) {
  const row = await database.prepare('SELECT repo_id FROM test_submissions WHERE submission_id=?').get(data.submissionId)
  return row?.repo_id
}
