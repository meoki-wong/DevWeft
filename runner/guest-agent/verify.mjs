import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto'
import { canonicalize } from './canonical.mjs'

export function signCanonical(privateKeyPem, value) {
  const payload = Buffer.from(canonicalize(value), 'utf8')
  const key = createPrivateKey(privateKeyPem)
  return sign(null, payload, key).toString('base64')
}

export function verifyCanonical(publicKeyPem, value, signatureB64) {
  const payload = Buffer.from(canonicalize(value), 'utf8')
  const key = createPublicKey(publicKeyPem)
  return verify(null, payload, key, Buffer.from(signatureB64, 'base64'))
}
