import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { instrumentPageActions, writeE2eActionLog, formatActionTrail } from '../runner/guest-agent/smoke.mjs'

describe('E2E 操作级流水', () => {
  it('包装 page.click/fill 记录 target 与参数', async () => {
    const log = []
    const calls = []
    const page = {
      click: async (sel) => { calls.push(['click', sel]); return 'ok' },
      fill: async (sel, v) => { calls.push(['fill', sel, v]); return 'ok' },
      locator: () => {
        const loc = {
          click: async () => { calls.push(['loc.click']); return 'ok' },
          first: () => loc,
        }
        return loc
      },
    }
    instrumentPageActions(page, log)
    await page.click('[data-test="btn-save"]')
    await page.fill('#name', '活动A')
    await page.locator('.item').click()
    expect(log.map((x) => x.action)).toEqual(['click', 'fill', 'locator.click'])
    expect(log[0].target).toBe('[data-test="btn-save"]')
    expect(log[1].args).toContain('活动A')
    expect(log.every((x) => x.status === 'ok')).toBe(true)
  })

  it('失败时标记 failed 并保留错误信息', async () => {
    const log = []
    const page = {
      click: async () => { throw new Error('Timeout 15000ms exceeded') },
    }
    instrumentPageActions(page, log)
    await expect(page.click('#x')).rejects.toThrow(/Timeout/)
    expect(log[0].status).toBe('failed')
    expect(log[0].detail).toMatch(/Timeout/)
  })

  it('writeE2eActionLog 落盘 JSON 供 artifact 收集', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'awp-e2e-'))
    writeE2eActionLog(runDir, 'activity-create', [
      { at: '2026-09-14T01:00:00Z', seq: 1, action: 'goto', target: '/app/x', status: 'ok' },
      { at: '2026-09-14T01:00:01Z', seq: 2, action: 'click', target: '[data-test="ok"]', status: 'ok' },
    ])
    const p = join(runDir, 'output', 'logs', 'e2e-actions-activity-create.json')
    expect(existsSync(p)).toBe(true)
    const j = JSON.parse(readFileSync(p, 'utf8'))
    expect(j.count).toBe(2)
    expect(j.steps[1].action).toBe('click')
  })

  it('formatActionTrail 输出最近步骤摘要（中文轨迹）', () => {
    const s = formatActionTrail([
      { action: 'goto', target: '/a', status: 'ok', name: '打开页面 /a' },
      { action: 'click', target: '#b', status: 'ok', name: '点击 #b' },
      { action: 'locator.fill', target: '#c', args: ['x'], status: 'failed' },
    ])
    expect(s).toMatch(/E2E|分步轨迹/)
    expect(s).toMatch(/click|点击/)
    expect(s).toMatch(/locator\.fill|填写/)
  })
})
