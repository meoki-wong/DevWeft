import { randomFillSync } from 'node:crypto'

export function uuidv7(now = Date.now()) {
  const bytes = Buffer.alloc(16)
  const ms = BigInt(now)
  bytes.writeUInt32BE(Number((ms >> 16n) & 0xffffffffn), 0)
  bytes.writeUInt16BE(Number(ms & 0xffffn), 4)
  randomFillSync(bytes, 6, 10)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function utcNow() {
  return new Date().toISOString()
}
