// eslint-ratchet 已废弃：改动文件用 eslint --no-ignore 直接检查
import { describe, it, expect } from 'vitest'
import { runEslintRatchet, eslintArgs } from '../runner/guest-agent/static.mjs'

describe('eslint-ratchet 已废弃', () => {
  it('无论是否命中基线，一律 passed + advisory', () => {
    const r = runEslintRatchet({ workspaceDir: '/tmp', runDir: null })
    expect(r.caseKey).toBe('test:static/eslint-ratchet')
    expect(r.status).toBe('passed')
    expect(r.detail).toContain('废弃')
  })
})

describe('eslint 改动文件 --no-ignore', () => {
  it('有改动文件时带 --no-ignore，不扫全仓', () => {
    const args = eslintArgs(['src/a.js'])
    expect(args).toContain('--no-ignore')
    expect(args).toContain('src/a.js')
    expect(args).not.toContain('.')
  })
})
