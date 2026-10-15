/**
 * standby-gate.test.mjs — 链路网关 §5 增强：备用机身份判定（db/standby.js）
 *
 * 极性=「备用机 opt-out」：默认(未设) 视为主机(worker)，跑全部后台；仅显式 AWP_STANDBY=1 才是 standby。
 * 这样主机/dev 忘配也零回归；多台备用机各自设同一 flag 即可。
 */
import { describe, expect, it } from 'vitest'
import { isStandbyControlPlane } from '../db/standby.js'

describe('§5 standby 判定', () => {
  it('未设 AWP_STANDBY → 主机（非 standby），默认跑全部后台', () => {
    expect(isStandbyControlPlane({})).toBe(false)
    expect(isStandbyControlPlane({ AWP_STANDBY: '' })).toBe(false)
  })
  it('AWP_STANDBY=1 → standby，跳过 nightly/dailySweep', () => {
    expect(isStandbyControlPlane({ AWP_STANDBY: '1' })).toBe(true)
  })
  it('值做 trim 容忍；但只有精确 1 才算 standby（避免误设 0/false 被当成真）', () => {
    expect(isStandbyControlPlane({ AWP_STANDBY: ' 1 ' })).toBe(true)
    expect(isStandbyControlPlane({ AWP_STANDBY: '0' })).toBe(false)
    expect(isStandbyControlPlane({ AWP_STANDBY: 'true' })).toBe(false)
  })
  it('process.env 缺省入参也能调用（不抛）', () => {
    expect(typeof isStandbyControlPlane()).toBe('boolean')
  })
})
