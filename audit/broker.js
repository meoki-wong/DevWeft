/**
 * audit/broker.js — 实时事件广播（SSE 订阅）
 */
import { EventEmitter } from 'node:events'

const broker = new EventEmitter()
broker.setMaxListeners(100)

export function publishAuditEvent(event) {
  broker.emit('audit', event)
}

export function subscribeAudit(callback) {
  broker.on('audit', callback)
  return () => broker.off('audit', callback)
}
