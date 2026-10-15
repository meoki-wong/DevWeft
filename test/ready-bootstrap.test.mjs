/**
 * ready-bootstrap.test.mjs — P1-C：就绪端口 + openDb 退避重试
 */
import { describe, it, expect } from 'vitest'
import { startReadinessBootstrap, openDbWithRetry } from '../db/ready-bootstrap.mjs'

async function httpJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

describe('startReadinessBootstrap', () => {
  it('live 恒 200；ready 先 503 后 200', async () => {
    const boot = await startReadinessBootstrap({ port: 0, host: '127.0.0.1' })
    try {
      expect((await httpJson(boot.port, '/api/health/live')).status).toBe(200)
      const before = await httpJson(boot.port, '/api/health/ready')
      expect(before.status).toBe(503)
      expect(before.body.code).toBe('DB_STARTING')
      boot.markReady()
      const after = await httpJson(boot.port, '/api/health/ready')
      expect(after.status).toBe(200)
      expect(after.body.code).toBe('READY')
    } finally {
      await boot.close()
    }
  })

  it('端口被占用时 reject（调用方可 exit）', async () => {
    const boot = await startReadinessBootstrap({ port: 0, host: '127.0.0.1' })
    try {
      // 再占同一端口必然失败
      await expect(startReadinessBootstrap({ port: boot.port, host: '127.0.0.1' })).rejects.toThrow()
    } finally {
      await boot.close()
    }
  })
})

describe('openDbWithRetry', () => {
  it('前两次 reject、第三次成功 → 返回尝试次数=3，不抛', async () => {
    let calls = 0
    const n = await openDbWithRetry(async () => {
      calls += 1
      if (calls < 3) throw new Error('ECONNREFUSED')
      return true
    }, { baseDelayMs: 5, maxDelayMs: 10, attemptTimeoutMs: 100, maxWaitMs: 5000 })
    expect(n).toBe(3)
    expect(calls).toBe(3)
  })

  it('openDb 永不 resolve（静默卡住）→ 单次超时后重试；总时限到 → 抛出', async () => {
    let calls = 0
    await expect(openDbWithRetry(() => { calls += 1; return new Promise(() => {}) }, {
      attemptTimeoutMs: 20, baseDelayMs: 5, maxDelayMs: 10, maxWaitMs: 120,
    })).rejects.toThrow(/超时/)
    expect(calls).toBeGreaterThanOrEqual(1)
  })
})
