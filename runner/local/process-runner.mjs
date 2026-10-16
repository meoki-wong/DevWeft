import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'

const DEFAULT_LOG_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000

function appendTail(current, chunk, limit) {
  const next = Buffer.concat([current, Buffer.from(chunk)])
  return next.length <= limit ? next : next.subarray(next.length - limit)
}

function signalTree(child, signal) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // taskkill /T targets descendants too; shell:false keeps the command line literal.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, shell: false,
    })
    killer.on('error', () => child.kill(signal))
    killer.on('exit', (code) => { if (code !== 0) child.kill(signal) })
    return
  }
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already exited */ } }
}

function safeLogName(checkId) {
  const safe = String(checkId || 'check').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  return safe || 'check'
}

/**
 * Execute an argv vector without a shell and return the same status fields on each OS.
 * stdout/stderr are retained as bounded tails and optionally written to separate log files.
 */
export function runProcess(command, {
  cwd,
  timeoutMs = 120_000,
  signal,
  checkId = 'check',
  logDir = null,
  maxLogBytes = DEFAULT_LOG_BYTES,
  killGraceMs = 500,
  env = process.env,
} = {}) {
  if (!Array.isArray(command) || command.length < 1 || command.some((arg) => typeof arg !== 'string' || !arg || /[\0\r\n]/.test(arg))) {
    return Promise.resolve({ status: 'error', exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: '', error: 'INVALID_COMMAND' })
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    return Promise.resolve({ status: 'error', exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: '', error: 'INVALID_TIMEOUT' })
  }
  if (signal?.aborted) {
    return Promise.resolve({ status: 'canceled', exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: '', error: 'RUNNER_CANCELED' })
  }

  return new Promise((resolve) => {
    const started = Date.now()
    const executable = command[0]
    const args = command.slice(1)
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let termination = null
    let spawnError = null
    let settled = false
    let killTimer = null
    let timeoutTimer = null
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const collect = (target, chunk) => {
      if (target === 'stdout') stdout = appendTail(stdout, chunk, maxLogBytes)
      else stderr = appendTail(stderr, chunk, maxLogBytes)
    }
    child.stdout?.on('data', (chunk) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk) => collect('stderr', chunk))
    child.on('error', (error) => { spawnError = error })

    const stop = (reason) => {
      if (termination || settled) return
      termination = reason
      signalTree(child, process.platform === 'win32' ? 'SIGTERM' : 'SIGTERM')
      killTimer = setTimeout(() => signalTree(child, 'SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }
    const onAbort = () => stop('canceled')
    signal?.addEventListener('abort', onAbort, { once: true })
    timeoutTimer = setTimeout(() => stop('timed_out'), timeoutMs)
    timeoutTimer.unref?.()

    child.on('close', (code, childSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      const out = stdout.toString('utf8')
      const err = stderr.toString('utf8')
      if (logDir) {
        mkdirSync(logDir, { recursive: true })
        const stem = safeLogName(checkId)
        writeFileSync(join(logDir, `${stem}.stdout.log`), out)
        writeFileSync(join(logDir, `${stem}.stderr.log`), err)
      }
      const status = termination || (spawnError ? 'error' : code === 0 ? 'passed' : 'failed')
      resolve({
        status,
        exitCode: Number.isInteger(code) ? code : null,
        signal: childSignal || null,
        durationMs: Math.max(0, Date.now() - started),
        stdout: out,
        stderr: err,
        ...(spawnError ? { error: `${basename(executable)}: ${spawnError.code || 'SPAWN_ERROR'}` } : {}),
        ...(termination ? { error: termination === 'timed_out' ? 'RUNNER_TIMEOUT' : 'RUNNER_CANCELED' } : {}),
      })
    })
  })
}
