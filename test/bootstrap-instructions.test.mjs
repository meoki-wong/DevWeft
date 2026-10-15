import { describe, it, expect } from 'vitest'
import { buildBootstrapInstructions } from '../harness/bootstrap-instructions.js'

describe('bootstrap instructions', () => {
  it('includes iron rules, repo binding, and always-first guidance', async () => {
    const text = await buildBootstrapInstructions({ repo: 'demo-app', username: 'alice' })
    expect(text).toContain('agent-workflow-platform')
    expect(text).toContain('demo-app')
    expect(text).toContain('alice')
    expect(text).toContain('harness_start')
    expect(text).toContain('harness_advance')
    expect(text.length).toBeGreaterThan(200)
  })

  it('does not inline the full rules manifest', async () => {
    const text = await buildBootstrapInstructions({ repo: 'demo' })
    expect(text).not.toContain('## Hard rules (RULES_MANIFEST summary)')
  })
})
