/**
 * 只读 ZIP central directory 解析（scanner 用）：不解压、不执行任何条目。
 * inflate() 仅按需解压单个文本条目用于 secret 扫描。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

export function readZipCentralEntries(buf) {
  if (!buf || buf.length < 22) throw new Error('ZIP_PARSE_TOO_SMALL')
  let eocd = -1
  const minOffset = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP_PARSE_NO_EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) throw new Error('ZIP_PARSE_BAD_CENTRAL')
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const crc32 = buf.readUInt32LE(offset + 16)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP_PARSE_BAD_LOCAL:${name}`)
    }
    entries.push({
      name,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      encrypted: (flags & 0x1) !== 0,
      inflate() {
        const localNameLen = buf.readUInt16LE(localOffset + 26)
        const localExtraLen = buf.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localNameLen + localExtraLen
        const data = buf.subarray(dataStart, dataStart + compressedSize)
        return method === 0 ? Buffer.from(data) : inflateRawSync(data)
      },
    })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}
