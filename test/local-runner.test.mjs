import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../runner/local/process-runner.mjs'

describe('local process runner', () => {
  it('uses argv without a shell, captures bounded output, and writes portable logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devweft-local-runner-'))
    try {
      const result = await runProcess([process.execPath, '-e', 'process.stdout.write("ok"); process.stderr.write("notice")'], {
        cwd: dir, checkId: 'node-unit', logDir: join(dir, 'logs'),
      })
      expect(result).toMatchObject({ status: 'passed', exitCode: 0, stdout: 'ok', stderr: 'notice' })
      expect(readFileSync(join(dir, 'logs', 'node-unit.stdout.log'), 'utf8')).toBe('ok')
      expect(readFileSync(join(dir, 'logs', 'node-unit.stderr.log'), 'utf8')).toBe('notice')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves nonzero exit codes and distinguishes timeouts from cancellation', async () => {
    const failed = await runProcess([process.execPath, '-e', 'process.exit(7)'], { timeoutMs: 2_000 })
    expect(failed).toMatchObject({ status: 'failed', exitCode: 7 })

    const timedOut = await runProcess([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 80, killGraceMs: 50 })
    expect(timedOut.status).toBe('timed_out')
    expect(timedOut.error).toBe('RUNNER_TIMEOUT')

    const controller = new AbortController()
    const pending = runProcess([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 2_000, signal: controller.signal, killGraceMs: 50,
    })
    setTimeout(() => controller.abort(), 40)
    const canceled = await pending
    expect(canceled.status).toBe('canceled')
    expect(canceled.error).toBe('RUNNER_CANCELED')
  })

  it('rejects invalid argv and timeouts without launching a child', async () => {
    expect(await runProcess('node --test')).toMatchObject({ status: 'error', error: 'INVALID_COMMAND' })
    expect(await runProcess(['node', '--test'], { timeoutMs: 0 })).toMatchObject({ status: 'error', error: 'INVALID_TIMEOUT' })
  })
})
