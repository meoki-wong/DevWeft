import { ApiError } from './errors.js'

function basename(p) {
  const parts = String(p).replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || ''
}

export function isSecretPath(relPath) {
  const base = basename(relPath)
  if (/^\.env($|\.)/i.test(base)) return true
  if (/^\.envrc$/i.test(base)) return true
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i.test(base)) return true
  if (/credential/i.test(base)) return true
  if (/\.token$/i.test(base)) return true
  return false
}

export function findSecretPaths(paths) {
  return (paths || []).filter((p) => isSecretPath(p))
}

export function assertNoSecretPaths(paths) {
  const hits = findSecretPaths(paths)
  if (hits.length) throw new ApiError('SECRET_FILES_DETECTED')
}
