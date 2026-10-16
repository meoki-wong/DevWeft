/** npm-proxy-only-v1：隔离 Internal 交换机上的受控代理坐标。禁止 Default Switch / 办公网桥接。 */
export const NETWORK_POLICY_ID = 'npm-proxy-only-v1'
export const SWITCH_NAME = process.env.AWP_VM_SWITCH_NAME || 'awp-isolated'
export const SWITCH_TYPE = 'Internal'
const DEFAULT_FABRIC_CIDR = '192.168.250.0/24'

export function parsePrivateIpv4Cidr24(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/24$/.exec(String(value || ''))
  if (!match) throw new Error('AWP_VM_NETWORK_CIDR must be an RFC1918 IPv4 /24 network, for example 192.168.250.0/24.')
  const octets = match.slice(1).map(Number)
  if (octets.some((octet) => octet < 0 || octet > 255) || octets[3] !== 0) {
    throw new Error('AWP_VM_NETWORK_CIDR must use a valid /24 network address ending in .0.')
  }
  const [a, b] = octets
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  if (!isPrivate) throw new Error('AWP_VM_NETWORK_CIDR must be inside RFC1918 private address space.')
  const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`
  if (`${prefix}.0/24` !== value) throw new Error('AWP_VM_NETWORK_CIDR must use canonical decimal octets.')
  return Object.freeze({
    cidr: `${prefix}.0/24`,
    proxyIp: `${prefix}.1`,
    guestIp: `${prefix}.10`,
    guestIpPool: Object.freeze(Array.from({ length: 16 }, (_, i) => `${prefix}.${11 + i}`)),
  })
}

const network = parsePrivateIpv4Cidr24(process.env.AWP_VM_NETWORK_CIDR || DEFAULT_FABRIC_CIDR)
export const FABRIC_CIDR = network.cidr
export const PROXY_IP = network.proxyIp
export const PROXY_PORT = 443
export const PROXY_HOST = 'packages.example.invalid'
/** golden/单机调试默认 Guest IP；并行 attempt 必须走 GUEST_IP_POOL */
export const GUEST_IP = network.guestIp
/**
 * 并行 VM Guest IP 池（.11–.26）。.1=宿主代理，.10=golden 默认。
 * 同一时刻一个 IP 最多绑定一个未释放 lease，避免 Internal 交换机 IP 冲突导致 ~30s infra_error。
 */
export const GUEST_IP_POOL = Object.freeze(
  network.guestIpPool
)
export const PREFIX_LENGTH = 24
export const REGISTRY_URL = 'https://packages.example.invalid/npm/'
function configuredPort(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer TCP port in 1..65535.`)
  return port
}
export const CONTROL_PLANE_PORTS = Object.freeze([...new Set([
  configuredPort('AWP_GATEWAY_PORT', 8787),
  configuredPort('AWP_BROKER_PORT', 8788),
  configuredPort('AWP_CONTROL_PORT', 8791),
  configuredPort('AWP_BLOB_PORT', 8792),
])])

export const DEFAULT_UPLINKS = {
  npmjs: 'https://registry.npmjs.org/',
}

/** leaseId → guestIp；进程内即可（worker 单进程并发 2–3） */
const guestIpHolds = new Map()
/** ip → cooldown 截止时间戳；网络类失败后短暂拉黑，避免连烧 attempt */
const guestIpCooldown = new Map()

export function acquireGuestIp(leaseId, { now = Date.now() } = {}) {
  if (!leaseId) throw new Error('acquireGuestIp: leaseId required')
  const held = guestIpHolds.get(leaseId)
  if (held) return held
  const used = new Set(guestIpHolds.values())
  for (const ip of GUEST_IP_POOL) {
    if (used.has(ip)) continue
    if ((guestIpCooldown.get(ip) || 0) > now) continue
    guestIpHolds.set(leaseId, ip)
    return ip
  }
  throw new Error(
    `GUEST_IP_POOL_EXHAUSTED: no free guest IP in ${GUEST_IP_POOL[0]}–${GUEST_IP_POOL[GUEST_IP_POOL.length - 1]}` +
      ` (held=${used.size}, cooling=${[...guestIpCooldown.entries()].filter(([, t]) => t > now).length})`
  )
}

/** 幂等释放；cooldownMs>0 时该 IP 冷却期内不再分配 */
export function releaseGuestIp(leaseId, { cooldownMs = 0, now = Date.now() } = {}) {
  const ip = guestIpHolds.get(leaseId)
  if (!ip) return null
  guestIpHolds.delete(leaseId)
  if (cooldownMs > 0) guestIpCooldown.set(ip, now + cooldownMs)
  return ip
}

export function listGuestIpHolds() {
  return Object.fromEntries(guestIpHolds)
}

export function clearGuestIpPoolState() {
  guestIpHolds.clear()
  guestIpCooldown.clear()
}

export function guestProxyConfig({ cafile }) {
  return {
    networkPolicyId: NETWORK_POLICY_ID,
    registry: REGISTRY_URL,
    proxyHost: PROXY_HOST,
    proxyIp: PROXY_IP,
    proxyPort: PROXY_PORT,
    cafile,
  }
}
