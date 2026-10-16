import { describe, expect, it } from 'vitest'
import db from '../db.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { containsCredentialLikeValue, containsRetiredBrand, isPipelineConfigurationPath } from '../scripts/public-residue.mjs'

describe('public defaults', () => {
  it('seeds neutral shared rules and a matching rule count', () => {
    const row = db.prepare(
      "SELECT d.content, r.rule_count FROM docs d JOIN rules_manifest r ON r.content=d.content WHERE d.repo='shared' AND d.name='RULES_MANIFEST' ORDER BY r.id DESC LIMIT 1"
    ).get()

    expect(row).toBeTruthy()
    const rules = row.content.split('\n').filter(Boolean)
    expect(row.rule_count).toBe(rules.length)
    expect(rules.length).toBeGreaterThan(0)
    expect(row.content).toContain('repository')
    expect(row.content).toContain('migration')
    expect(containsRetiredBrand(row.content)).toBe(false)
  })

  it('ships a neutral MCP template and safe DevWeft project guidance', () => {
    const mcp = JSON.parse(readFileSync(join(process.cwd(), 'templates/mcp.json'), 'utf8'))
    const agents = readFileSync(join(process.cwd(), 'templates/AGENTS.md'), 'utf8')
    expect(mcp.mcpServers.devweft).toBeTruthy()
    expect(Object.keys(mcp.mcpServers)).toEqual(['devweft'])
    expect(agents).toContain('DevWeft MCP server')
    expect(agents).not.toMatch(/git add -N \./i)
  })

  it('recognizes retired names without embedding them as plain text', () => {
    const retiredSamples = [
      [0x6d, 0x78, 0x74, 0x2d, 0x6d, 0x79, 0x6d, 0x69, 0x78, 0x75, 0x65, 0x2d, 0x68, 0x35],
      [0x6d, 0x79, 0x6d, 0x69, 0x78, 0x75, 0x65],
      [0x6d, 0x78, 0x62, 0x63],
      [0x6d, 0x69, 0x78, 0x75, 0x65],
      [0x871c, 0x96ea],
    ].map((points) => String.fromCodePoint(...points))

    for (const sample of retiredSamples) {
      expect(containsRetiredBrand(`project: ${sample}`)).toBe(true)
    }
    expect(containsRetiredBrand('DevWeft open source project')).toBe(false)
  })

  it('finds credential-shaped values without flagging public placeholders', () => {
    const samples = [
      `ghp_${'a'.repeat(36)}`,
      `github_pat_${'a'.repeat(36)}`,
      `AKIA${'A'.repeat(16)}`,
      `AIza${'a'.repeat(35)}`,
      `sk-ant-${'a'.repeat(24)}`,
      `xoxb-${'a'.repeat(20)}`,
      ['-----BEGIN ', 'PRIVATE KEY', '-----'].join(''),
    ]

    for (const sample of samples) {
      expect(containsCredentialLikeValue(sample)).toBe(true)
    }
    expect(containsCredentialLikeValue('replace-with-your-token')).toBe(false)
  })

  it('rejects common CI pipeline paths across providers and path separators', () => {
    const pipelinePaths = [
      'Jenkinsfile',
      'services/api/Jenkinsfile.groovy',
      '.gitlab-ci.yaml',
      'azure-pipelines.yml',
      'bitbucket-pipelines.yml',
      '.travis.yml',
      'appveyor.yml',
      '.drone.yaml',
      '.woodpecker.yml',
      '.github/workflows/release.yml',
      '.circleci/config.yaml',
      '.buildkite/pipeline.yml',
      '.semaphore/semaphore.yml',
      '.teamcity/settings.kts',
      '.harness/pipelines/release.yaml',
      '.tekton/pipeline.yaml',
      '.github\\workflows\\release.yml',
    ]
    for (const file of pipelinePaths) expect(isPipelineConfigurationPath(file), file).toBe(true)

    for (const file of ['README.md', 'docs/Jenkinsfile-history.md', 'contracts/testing-openapi.yaml', 'src/.circleci-notes.js']) {
      expect(isPipelineConfigurationPath(file), file).toBe(false)
    }
  })
})
