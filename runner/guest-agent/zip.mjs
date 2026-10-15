/**
 * 最小确定性 ZIP writer（§12 artifact.zip）。不引入新依赖：deflate 用 node:zlib。
 * 固定 DOS 时间戳保证相同内容产生相同字节；条目按名称排序去重。
 */
import { deflateRawSync } from 'node:zlib'

const DOS_TIME = 0 // 1980-01-01 00:00:00（DOS 时间基准）
const DOS_DATE = (2026 - 1980) * 512 + 9 * 32 // 2026-09-03 固定值，确定性要求

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function assertEntryName(name) {
  if (typeof name !== 'string' || !name.length || name.length > 512) throw new Error('ZIP_ENTRY_NAME_INVALID')
  if (name.includes('\\') || name.includes('\0')) throw new Error('ZIP_ENTRY_NAME_INVALID')
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error('ZIP_ENTRY_NAME_INVALID')
  for (const part of name.split('/')) {
    if (part === '' || part === '.' || part === '..') throw new Error('ZIP_ENTRY_NAME_INVALID')
  }
}

export function createZip(rawEntries, { validateNames = true } = {}) {
  const seen = new Set()
  const entries = [...rawEntries]
    .map((e) => ({ ...e }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (validateNames) assertEntryName(e.name)
    if (seen.has(e.name)) throw new Error('ZIP_ENTRY_NAME_INVALID')
    seen.add(e.name)
    if (!Buffer.isBuffer(e.data)) throw new Error('ZIP_ENTRY_NAME_INVALID')
  }
  const chunks = []
  const central = []
  let offset = 0
  const utf8 = (s) => Buffer.from(s, 'utf8')
  for (const e of entries) {
    const nameBuf = utf8(e.name)
    const crc = crc32(e.data)
    let method = 8
    let payload = deflateRawSync(e.data, { level: 6 })
    if (payload.length >= e.data.length) {
      method = 0
      payload = e.data
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(DOS_TIME, 12)
    cd.writeUInt16LE(DOS_DATE, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, cdBuf, eocd])
}
