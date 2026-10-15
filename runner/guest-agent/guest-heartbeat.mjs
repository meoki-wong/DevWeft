/**
 * Guest 心跳（§11.2：Guest 5s 心跳，停滞阈值 30s）。
 * Guest Agent 在 output 目录写 guest-heartbeat.json；宿主 watchdog 读文件年龄判断停滞。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const GUEST_HEARTBEAT_INTERVAL_MS = 5000
export const GUEST_HEARTBEAT_STALL_MS = 30000

export function startGuestHeartbeat(runDir, { intervalMs = GUEST_HEARTBEAT_INTERVAL_MS, pid = process.pid } = {}) {
  const outputDir = join(runDir, 'output')
  mkdirSync(outputDir, { recursive: true })
  const file = join(outputDir, 'guest-heartbeat.json')
  const tick = () => writeFileSync(file, JSON.stringify({ pid, at: new Date().toISOString() }))
  tick()
  const timer = setInterval(tick, intervalMs)
  return () => {
    clearInterval(timer)
    tick()
  }
}

export function readGuestHeartbeatAgeMs(runDir, now = new Date()) {
  const file = join(runDir, 'output', 'guest-heartbeat.json')
  if (!existsSync(file)) return Number.POSITIVE_INFINITY
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  return Math.max(0, now.getTime() - Date.parse(doc.at))
}
