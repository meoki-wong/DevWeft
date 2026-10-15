/**
 * Out-of-band secret material injection. Reads plaintext from stdin.
 * Usage: node secret-broker/put-secret.mjs <secretRef> < data.txt
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrokerDb, putSecret } from './store.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const secretRef = process.argv[2]
if (!secretRef) {
  process.stderr.write('usage: node secret-broker/put-secret.mjs <secretRef>\n')
  process.exit(2)
}

const dbPath = process.env.AWP_BROKER_DB || path.join(root, 'data', 'secret-broker.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })
const plaintext = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '')
const db = openBrokerDb(dbPath)
putSecret(db, secretRef, plaintext)
db.close()
process.stdout.write(`stored ${secretRef}\n`)
