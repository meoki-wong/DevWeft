/**
 * SFC 改动清单：loadLintableChangedFiles 行为（对齐 static.mjs 现状）
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadLintableChangedFiles } from '../runner/guest-agent/static.mjs'

function seedWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'awp-sfc-'))
  const runDir = join(dir, 'run')
  mkdirSync(join(runDir, 'input'), { recursive: true })
  return { dir, runDir }
}

describe('loadLintableChangedFiles', () => {
  it('无清单 → files=[]，reason 说明缺失', () => {
    const { dir, runDir } = seedWorkspace()
    const r = loadLintableChangedFiles(dir, runDir)
    expect(r.files).toEqual([])
    expect(r.reason).toMatch(/manifest|changed-files/i)
  })

  it('清单含不存在文件：仅保留磁盘上存在的可 lint 文件', () => {
    const { dir, runDir } = seedWorkspace()
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(runDir, 'input', 'changed-files.json'), JSON.stringify(['src/a.vue', 'src/missing.vue']))
    writeFileSync(join(dir, 'src', 'a.vue'), '<template><div/></template>')
    const r = loadLintableChangedFiles(dir, runDir)
    expect(r.files).toEqual(['src/a.vue'])
  })

  it('清单损坏 → files=null（fail-fast）', () => {
    const { dir, runDir } = seedWorkspace()
    writeFileSync(join(runDir, 'input', 'changed-files.json'), '{not-json')
    const r = loadLintableChangedFiles(dir, runDir)
    expect(r.files).toBeNull()
    expect(r.reason).toMatch(/parse/i)
  })

  it('无可 lint 后缀 → files=[] skipped 语义', () => {
    const { dir, runDir } = seedWorkspace()
    writeFileSync(join(dir, 'readme.md'), '# x')
    writeFileSync(join(runDir, 'input', 'changed-files.json'), JSON.stringify(['readme.md']))
    const r = loadLintableChangedFiles(dir, runDir)
    expect(r.files).toEqual([])
    expect(r.reason).toMatch(/no lintable/i)
  })
})
