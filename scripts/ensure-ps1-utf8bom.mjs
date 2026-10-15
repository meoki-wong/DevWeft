/**
 * Windows PowerShell 5.1 需要 UTF-8 BOM 才能正确解析中文脚本。
 * Usage: node scripts/ensure-ps1-utf8bom.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  'scripts/fresh-deploy.ps1',
  'scripts/deploy-test-platform.ps1',
  'scripts/setup-local-postgres.ps1',
  'scripts/verify-test-platform.ps1',
  'scripts/start-platform.ps1',
  'scripts/start-node.ps1',
  'scripts/stop-test-platform.ps1',
  'scripts/gen-dev-pki.ps1',
  'scripts/windows/isolated-network.ps1',
  'scripts/windows/ensure-isolated-network.ps1',
  'runner/host-worker/hyperv-transfer.ps1',
  'runner/host-worker/hyperv-static-lane.ps1',
  'runner/guest-agent/job-object.ps1',
]
const bom = Buffer.from([0xef, 0xbb, 0xbf])
for (const rel of files) {
  const p = path.join(root, rel)
  const buf = fs.readFileSync(p)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    process.stdout.write(`bom-ok ${rel}\n`)
    continue
  }
  fs.writeFileSync(p, Buffer.concat([bom, buf]))
  process.stdout.write(`bom-added ${rel}\n`)
}
