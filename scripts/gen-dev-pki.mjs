/**
 * Dev/PoC mTLS materials. Node 22 only — does not use Windows PowerShell crypto APIs.
 * Usage: node scripts/gen-dev-pki.mjs [outDir]
 */
import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomUUID,
  X509Certificate,
} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OID = {
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
}

function concat(...parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
}

function derLen(n) {
  if (n < 128) return Buffer.from([n])
  if (n < 256) return Buffer.from([0x81, n])
  if (n < 65536) return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff])
  throw new Error('DER length too large')
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : concat(...content)
  return concat(Buffer.from([tag]), derLen(body.length), body)
}

function seq(...items) {
  return tlv(0x30, concat(...items))
}

function setOf(...items) {
  return tlv(0x31, concat(...items))
}

function oid(str) {
  const parts = str.split('.').map(Number)
  const rest = [parts[0] * 40 + parts[1]]
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]
    const stack = [v & 0x7f]
    v >>= 7
    while (v > 0) {
      stack.push((v & 0x7f) | 0x80)
      v >>= 7
    }
    for (let j = stack.length - 1; j >= 0; j--) rest.push(stack[j])
  }
  return tlv(0x06, Buffer.from(rest))
}

function derInt(buf) {
  let b = Buffer.from(buf)
  while (b.length > 1 && b[0] === 0) b = b.subarray(1)
  if (b[0] & 0x80) b = concat(Buffer.from([0x00]), b)
  return tlv(0x02, b)
}

function derIntNumber(n) {
  if (n === 0) return tlv(0x02, Buffer.from([0]))
  const bytes = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  return derInt(Buffer.from(bytes))
}

function bitString(buf, unused = 0) {
  return tlv(0x03, concat(Buffer.from([unused]), buf))
}

function octetString(buf) {
  return tlv(0x04, buf)
}

function bool(v) {
  return tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
}

function ctxExplicit(n, content) {
  return tlv(0xa0 + n, content)
}

function utf8(s) {
  return tlv(0x0c, Buffer.from(s, 'utf8'))
}

function algId(oidStr) {
  return seq(oid(oidStr), tlv(0x05, Buffer.alloc(0)))
}

function nameCN(cn) {
  return seq(setOf(seq(oid(OID.commonName), utf8(cn))))
}

function extension(oidStr, critical, value) {
  const parts = [oid(oidStr)]
  if (critical) parts.push(bool(true))
  parts.push(octetString(value))
  return seq(...parts)
}

function sanExt(dnsNames, ips) {
  const parts = []
  for (const d of dnsNames) parts.push(tlv(0x82, Buffer.from(d, 'ascii')))
  for (const ip of ips) {
    const m = String(ip).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (m) parts.push(tlv(0x87, Buffer.from(m.slice(1).map(Number))))
  }
  return extension(OID.subjectAltName, false, seq(...parts))
}

function basicConstraintsExt(ca) {
  const inner = ca ? seq(bool(true), derIntNumber(3)) : seq()
  return extension(OID.basicConstraints, true, inner)
}

function keyUsageExt(ca) {
  if (ca) return extension(OID.keyUsage, true, bitString(Buffer.from([0x86]), 1))
  return extension(OID.keyUsage, true, bitString(Buffer.from([0xa0]), 5))
}

function ekuExt() {
  return extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth), oid(OID.clientAuth)))
}

function utcTime(d) {
  const yy = String(d.getUTCFullYear()).slice(-2)
  const p = (n) => String(n).padStart(2, '0')
  const s = `${yy}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

function issueCert({ subjectCN, issuerCN, subjectKey, issuerKey, isCa, dnsNames, ips, serial }) {
  const now = new Date()
  const notBefore = new Date(now.getTime() - 60 * 1000)
  const notAfter = new Date(now.getTime() + 5 * 365 * 24 * 60 * 60 * 1000)
  const spki = subjectKey.publicKey.export({ type: 'spki', format: 'der' })
  const extensions = [basicConstraintsExt(isCa), keyUsageExt(isCa)]
  if (!isCa) {
    extensions.push(ekuExt())
    if ((dnsNames && dnsNames.length) || (ips && ips.length)) {
      extensions.push(sanExt(dnsNames || [], ips || []))
    }
  }
  const tbs = seq(
    ctxExplicit(0, derIntNumber(2)),
    derIntNumber(serial),
    algId(OID.sha256WithRSAEncryption),
    nameCN(issuerCN),
    seq(utcTime(notBefore), utcTime(notAfter)),
    nameCN(subjectCN),
    spki,
    ctxExplicit(3, seq(...extensions))
  )
  const signer = createSign('SHA256')
  signer.update(tbs)
  const sig = signer.sign(issuerKey.privateKey)
  return seq(tbs, algId(OID.sha256WithRSAEncryption), bitString(sig))
}

function pem(type, der) {
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`
}

function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function genKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
}

function writePair(outDir, name, der, keypair) {
  fs.writeFileSync(path.join(outDir, `${name}.crt`), pem('CERTIFICATE', der))
  fs.writeFileSync(
    path.join(outDir, `${name}.key`),
    keypair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  )
}

export function generateDevPki(outDir, { hostname = os.hostname() } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const caKey = genKey()
  const brokerKey = genKey()
  const cpKey = genKey()
  const workerKey = genKey()

  const caDer = issueCert({
    subjectCN: 'awp-dev-ca',
    issuerCN: 'awp-dev-ca',
    subjectKey: caKey,
    issuerKey: caKey,
    isCa: true,
    serial: 1,
  })
  const brokerDns = ['localhost', 'awp-secret-broker']
  if (hostname && hostname !== 'localhost') brokerDns.push(hostname)
  const brokerDer = issueCert({
    subjectCN: 'awp-secret-broker',
    issuerCN: 'awp-dev-ca',
    subjectKey: brokerKey,
    issuerKey: caKey,
    isCa: false,
    dnsNames: brokerDns,
    ips: ['127.0.0.1'],
    serial: 2,
  })
  const cpDer = issueCert({
    subjectCN: 'awp-control-plane',
    issuerCN: 'awp-dev-ca',
    subjectKey: cpKey,
    issuerKey: caKey,
    isCa: false,
    dnsNames: ['awp-control-plane', 'localhost'],
    serial: 3,
  })
  const workerDer = issueCert({
    subjectCN: 'awp-worker',
    issuerCN: 'awp-dev-ca',
    subjectKey: workerKey,
    issuerKey: caKey,
    isCa: false,
    dnsNames: ['awp-worker', 'localhost'],
    serial: 4,
  })

  writePair(outDir, 'ca', caDer, caKey)
  writePair(outDir, 'broker', brokerDer, brokerKey)
  writePair(outDir, 'control-plane', cpDer, cpKey)
  writePair(outDir, 'worker', workerDer, workerKey)

  const caCert = new X509Certificate(pem('CERTIFICATE', caDer))
  const brokerCert = new X509Certificate(pem('CERTIFICATE', brokerDer))
  if (!brokerCert.verify(caCert.publicKey)) throw new Error('broker cert failed CA verify')

  const workerIdPath = path.join(outDir, 'worker-id.txt')
  let workerId
  if (fs.existsSync(workerIdPath)) {
    workerId = fs.readFileSync(workerIdPath, 'utf8').trim()
  } else {
    workerId = randomUUID()
    fs.writeFileSync(workerIdPath, `${workerId}\n`)
  }

  const trust = {
    controlPlaneThumbprints: [sha256hex(cpDer)],
    workers: [{ workerId, thumbprint: sha256hex(workerDer) }],
  }
  fs.writeFileSync(path.join(outDir, 'trust.json'), `${JSON.stringify(trust, null, 2)}\n`)
  return trust
}

export function issuePackagesProxyCert(caDir, outDir, {
  dnsNames = ['packages.example.invalid'],
  ips = ['192.168.250.1'],
  serial = 10,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const caCrtPem = fs.readFileSync(path.join(caDir, 'ca.crt'))
  const caKeyPem = fs.readFileSync(path.join(caDir, 'ca.key'))
  const issuerKey = { privateKey: createPrivateKey(caKeyPem) }
  const subjectKey = genKey()
  const der = issueCert({
    subjectCN: 'packages.example.invalid',
    issuerCN: 'awp-dev-ca',
    subjectKey,
    issuerKey,
    isCa: false,
    dnsNames,
    ips,
    serial,
  })
  writePair(outDir, 'packages.example.invalid', der, subjectKey)
  fs.copyFileSync(path.join(caDir, 'ca.crt'), path.join(outDir, 'ca.crt'))
  const leaf = new X509Certificate(pem('CERTIFICATE', der))
  const ca = new X509Certificate(caCrtPem)
  if (!leaf.verify(ca.publicKey)) throw new Error('packages cert failed CA verify')
  return {
    certPath: path.join(outDir, 'packages.example.invalid.crt'),
    keyPath: path.join(outDir, 'packages.example.invalid.key'),
    caPath: path.join(outDir, 'ca.crt'),
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv[2] === '--packages') {
    const caDir = process.argv[3] || path.join(repoRoot, 'secret-broker', 'dev-certs')
    const outDir = process.argv[4] || path.join(caDir)
    const issued = issuePackagesProxyCert(caDir, outDir)
    process.stdout.write(`packages cert ${issued.certPath}\n`)
  } else {
    const outDir = process.argv[2] || path.join(repoRoot, 'secret-broker', 'dev-certs')
    const trust = generateDevPki(outDir)
    process.stdout.write(`PKI written to ${outDir}\n`)
    process.stdout.write(`control-plane thumbprint: ${trust.controlPlaneThumbprints[0]}\n`)
    process.stdout.write(`worker thumbprint: ${trust.workers[0].thumbprint}\n`)
    process.stdout.write(`workerId: ${trust.workers[0].workerId}\n`)
  }
}
