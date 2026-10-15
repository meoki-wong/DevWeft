/**
 * audit/routes.js — 审计 API + SSE 实时流
 */
import express from 'express'
import {
  queryAuditEvents,
  listAuditAuthors,
  listAuditSessions,
  subscribeAudit,
  queryTrace,
} from './index.js'

export function mountAuditRoutes(app) {
  app.get('/api/audit/events', async (req, res) => {
    const { author, sessionId, repo, tool, limit, sinceId } = req.query
    const events = await queryAuditEvents({
      author: author ? String(author) : undefined,
      sessionId: sessionId ? String(sessionId) : undefined,
      repo: repo ? String(repo) : undefined,
      toolName: tool ? String(tool) : undefined,
      limit: limit ? Number(limit) : 200,
      sinceId: sinceId ? Number(sinceId) : 0,
    })
    res.json({ ok: true, events })
  })

  /** 全链路时间线：一次任务/一次下单的完整轨迹 */
  app.get('/api/audit/trace', async (req, res) => {
    const { taskId, submissionId, traceId, repo, limit } = req.query
    const out = await queryTrace({
      taskId: taskId ? String(taskId) : null,
      submissionId: submissionId ? String(submissionId) : null,
      traceId: traceId ? String(traceId) : null,
      repo: repo ? String(repo) : null,
      limit: limit ? Number(limit) : 500,
    })
    res.status(out.ok ? 200 : 400).json(out)
  })

  app.get('/api/audit/authors', async (req, res) => {
    res.json({ ok: true, authors: await listAuditAuthors() })
  })

  app.get('/api/audit/sessions', async (req, res) => {
    const { author, limit } = req.query
    res.json({
      ok: true,
      sessions: await listAuditSessions({
        author: author ? String(author) : undefined,
        limit: limit ? Number(limit) : 30,
      }),
    })
  })

  /** SSE 实时流：?author=张三&sessionId=xxx */
  app.get('/api/audit/stream', (req, res) => {
    const filterAuthor = req.query.author ? String(req.query.author) : null
    const filterSession = req.query.sessionId ? String(req.query.sessionId) : null

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event) => {
      if (filterAuthor && event.author !== filterAuthor) return
      if (filterSession && event.session_id !== filterSession) return
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    const unsub = subscribeAudit(send)
    res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`)

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 25000)

    req.on('close', () => {
      clearInterval(heartbeat)
      unsub()
    })
  })
}
