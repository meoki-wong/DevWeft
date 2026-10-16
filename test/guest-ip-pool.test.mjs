import { describe, expect, it, beforeEach } from 'vitest'
import {
  GUEST_IP_POOL,
  GUEST_IP,
  acquireGuestIp,
  releaseGuestIp,
  listGuestIpHolds,
  clearGuestIpPoolState,
  parsePrivateIpv4Cidr24,
} from '../runner/network/policy.mjs'

describe('guest IP pool (parallel attempt isolation)', () => {
  beforeEach(() => {
    clearGuestIpPoolState()
  })

  it('derives isolated addresses from an alternate private /24', () => {
    const network = parsePrivateIpv4Cidr24('10.42.7.0/24')
    expect(network).toMatchObject({
      cidr: '10.42.7.0/24',
      proxyIp: '10.42.7.1',
      guestIp: '10.42.7.10',
    })
    expect(network.guestIpPool.slice(0, 2)).toEqual(['10.42.7.11', '10.42.7.12'])
    expect(network.guestIpPool).toHaveLength(16)
  })

  it.each(['8.8.8.0/24', '192.168.4.1/24', '10.0.0.0/16', '172.32.1.0/24', '256.1.1.0/24']) (
    'rejects invalid or non-private network %s', (cidr) => {
      expect(() => parsePrivateIpv4Cidr24(cidr)).toThrow(/AWP_VM_NETWORK_CIDR/)
    },
  )

  it('pool excludes host proxy .1 and golden default .10', () => {
    expect(GUEST_IP_POOL).not.toContain('192.168.250.1')
    expect(GUEST_IP_POOL).not.toContain(GUEST_IP)
    expect(GUEST_IP_POOL.length).toBeGreaterThanOrEqual(3)
  })

  it('gives distinct IPs to concurrent leases', () => {
    const a = acquireGuestIp('lease-a')
    const b = acquireGuestIp('lease-b')
    const c = acquireGuestIp('lease-c')
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(a).not.toBe(c)
    expect(GUEST_IP_POOL).toEqual(expect.arrayContaining([a, b, c]))
  })

  it('is idempotent per lease and frees on release', () => {
    const a1 = acquireGuestIp('lease-a')
    const a2 = acquireGuestIp('lease-a')
    expect(a1).toBe(a2)
    expect(releaseGuestIp('lease-a')).toBe(a1)
    expect(releaseGuestIp('lease-a')).toBe(null)
    const b = acquireGuestIp('lease-b')
    expect(GUEST_IP_POOL).toContain(b)
  })

  it('cooldown blocks reuse until expiry', () => {
    const ip = acquireGuestIp('lease-a')
    releaseGuestIp('lease-a', { cooldownMs: 60_000, now: 1_000 })
    const held = []
    // 池 16 个，1 个在冷却 → 最多再拿 15 个，且都不是冷却中的那个
    for (let i = 0; i < GUEST_IP_POOL.length - 1; i += 1) {
      held.push(acquireGuestIp(`lease-${i}`, { now: 1_000 }))
    }
    expect(held).not.toContain(ip)
    expect(() => acquireGuestIp('lease-extra', { now: 1_000 })).toThrow(/GUEST_IP_POOL_EXHAUSTED/)
    for (const id of held) releaseGuestIp(id)
    expect(acquireGuestIp('lease-reuse', { now: 1_000 + 60_001 })).toBeTruthy()
  })

  it('throws when pool exhausted', () => {
    const ids = GUEST_IP_POOL.map((_, i) => `lease-${i}`)
    for (const id of ids) acquireGuestIp(id)
    expect(() => acquireGuestIp('lease-overflow')).toThrow(/GUEST_IP_POOL_EXHAUSTED/)
  })

  it('listGuestIpHolds reflects active bindings', () => {
    acquireGuestIp('lease-a')
    expect(Object.keys(listGuestIpHolds())).toContain('lease-a')
  })
})
