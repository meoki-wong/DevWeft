import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

function rewriteImports(src) {
  return src
    .replaceAll('../../contracts/version.mjs', './canonical.mjs')
    .replaceAll('../../testing/signing.js', './verify.mjs')
    // guest 包平铺进 input/ 后目录层级消失，../report-steps.js 会指向包外不存在的路径；
    // 重定向到同目录下的 report-steps.mjs（下方 stage 时一并打入）
    .replaceAll('../report-steps.js', './report-steps.mjs')
}

export function stageGuestPack(destDir) {
  mkdirSync(destDir, { recursive: true })
  writeFileSync(join(destDir, 'canonical.mjs'), readFileSync(join(repoRoot, 'contracts', 'version.mjs')))
  writeFileSync(join(destDir, 'verify.mjs'), rewriteImports(readFileSync(join(here, 'verify.mjs'), 'utf8')))
  writeFileSync(join(destDir, 'static.mjs'), readFileSync(join(here, 'static.mjs')))
  writeFileSync(join(destDir, 'unbundle.mjs'), readFileSync(join(here, 'unbundle.mjs')))
  writeFileSync(join(destDir, 'install.mjs'), readFileSync(join(here, 'install.mjs')))
  writeFileSync(join(destDir, 'zip.mjs'), readFileSync(join(here, 'zip.mjs')))
  writeFileSync(join(destDir, 'artifact.mjs'), rewriteImports(readFileSync(join(here, 'artifact.mjs'), 'utf8')))
  writeFileSync(join(destDir, 'units.mjs'), readFileSync(join(here, 'units.mjs')))
  writeFileSync(join(destDir, 'smoke.mjs'), rewriteImports(readFileSync(join(here, 'smoke.mjs'), 'utf8')))
  // report-steps.js 是 smoke.mjs 的依赖（纯 ESM 命名导出、自身无 import）；
  // 漏打会导致 guest agent 在模块链接期 ERR_MODULE_NOT_FOUND 秒崩，且 VM 不关机拖成 45min 超时（云端测试卡死根因）
  writeFileSync(join(destDir, 'report-steps.mjs'), readFileSync(join(here, '..', 'report-steps.js')))
  writeFileSync(join(destDir, 'guest-heartbeat.mjs'), readFileSync(join(here, 'guest-heartbeat.mjs')))
  writeFileSync(join(destDir, 'sidecar.mjs'), rewriteImports(readFileSync(join(here, 'sidecar.mjs'), 'utf8')))
  writeFileSync(join(destDir, 'index.mjs'), rewriteImports(readFileSync(join(here, 'index.mjs'), 'utf8')))
  cpSync(join(here, 'job-object.ps1'), join(destDir, 'job-object.ps1'))
  return {}
}
