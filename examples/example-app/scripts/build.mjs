import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const side = process.argv[2]
if (!['web', 'admin'].includes(side)) throw new Error('Usage: node scripts/build.mjs <web|admin>')
const destination = path.join(root, 'dist', side)
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(path.join(root, 'src', side, 'index.html'), path.join(destination, 'index.html'))
process.stdout.write(`built ${side} page\n`)
