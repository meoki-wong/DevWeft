/** npm-proxy-only-v1：隔离 Internal 交换机上的受控代理坐标。禁止 Default Switch / 办公网桥接。 */
export const NETWORK_POLICY_ID = 'npm-proxy-only-v1'
export const SWITCH_NAME = process.env.AWP_VM_SWITCH_NAME || 'awp-isolated'
export const SWITCH_TYPE = 'Internal'
export const FABRIC_CIDR = '192.168.250.0/24'
export const PROXY_IP = '192.168.250.1'
export const PROXY_PORT = 443
export const PROXY_HOST = 'packages.example.invalid'
/** golden/单机调试默认 Guest IP；并行 attempt 必须走 GUEST_IP_POOL */
export const GUEST_IP = '192.168.250.10'
/**
 * 并行 VM Guest IP 池（.11–.26）。.1=宿主代理，.10=golden 默认。
 * 同一时刻一个 IP 最多绑定一个未释放 lease，避免 Internal 交换机 IP 冲突导致 ~30s infra_error。
 */
export const GUEST_IP_POOL = Object.freeze(
  Array.from({ length: 16 }, (_, i) => `192.168.250.${11 + i}`)
)
export const PREFIX_LENGTH = 24
export const REGISTRY_URL = 'https://packages.example.invalid/npm/'
export const CONTROL_PLANE_PORTS = [8787, 8788]

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
