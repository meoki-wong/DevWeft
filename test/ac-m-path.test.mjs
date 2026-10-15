/**
 * size/type 冻结 + M 路径 AC 必填 + DONE 前 AC 复查
 */
import { describe, expect, it } from 'vitest'
import { checkAcDiscipline } from '../harness/testing-gate.js'

const AC = [{ id: 'AC-1', text: '点击提交后接口返回 200 且列表刷新', type: 'contract' }]

describe('checkAcDiscipline M path', () => {
  it('M: CLASSIFY→EXECUTE enforce 无 AC → AC_REQUIRED', () => {
    const r = checkAcDiscipline({
      phase: 'CLASSIFY', to: 'EXECUTE', size: 'M', mode: 'enforce_ml',
      metaAcceptance: null, acceptanceInput: null,
    })
    expect(r?.code).toBe('AC_REQUIRED')
  })

  it('M: CLASSIFY→EXECUTE 带 AC → 放行', () => {
    const r = checkAcDiscipline({
      phase: 'CLASSIFY', to: 'EXECUTE', size: 'M', mode: 'enforce_ml',
      metaAcceptance: null, acceptanceInput: AC,
    })
    expect(r).toBeNull()
  })

  it('L: PLAN→EXECUTE 仍强制 AC', () => {
    const r = checkAcDiscipline({
      phase: 'PLAN', to: 'EXECUTE', size: 'L', mode: 'enforce_all',
      metaAcceptance: null, acceptanceInput: null,
    })
    expect(r?.code).toBe('AC_REQUIRED')
  })

  it('observe 仓 M 无 AC 不拦', () => {
    const r = checkAcDiscipline({
      phase: 'CLASSIFY', to: 'EXECUTE', size: 'M', mode: 'observe',
      metaAcceptance: null, acceptanceInput: null,
    })
    expect(r).toBeNull()
  })

  it('快照之后改 AC → AC_FROZEN；快照之前可以改', () => {
    const changed = [{ id: 'AC-1', text: '点击提交后接口返回 400 且错误提示展示', type: 'contract' }]
    const open = checkAcDiscipline({
      phase: 'execute', to: 'static', size: 'M', mode: 'enforce_ml',
      metaAcceptance: AC, acceptanceInput: changed,
    })
    expect(open).toBeNull()
    const frozen = checkAcDiscipline({
      phase: 'execute', to: 'static', size: 'M', mode: 'enforce_ml',
      metaAcceptance: AC, acceptanceInput: changed, snapshotFrozen: true,
    })
    expect(frozen?.code).toBe('AC_FROZEN')
  })

  it('进入 EXECUTE 前已冻结则 M 路径可复用 meta.acceptance', () => {
    const r = checkAcDiscipline({
      phase: 'CLASSIFY', to: 'EXECUTE', size: 'M', mode: 'enforce_ml',
      metaAcceptance: AC, acceptanceInput: null,
    })
    expect(r).toBeNull()
  })
})
