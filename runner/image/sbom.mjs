/**
 * Golden image SBOM（§9.2：镜像必须带 SBOM）。
 * golden-first-boot 在首启时写 installed-components.json，build-golden-vhdx 以本模块生成 SBOM。
 * 文档内容进 canonical JSON 摘要；组件列表确定性排序。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { documentSha256 } from '../../contracts/version.mjs'

export function buildSbomDocument({ imageId, components, generatedAt }) {
  const list = (components || []).map((c) => ({
    name: String(c.name),
    version: String(c.version),
    source: String(c.source || ''),
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    schemaVersion: 1,
    imageId,
    generatedAt,
    components: list,
  }
}

export function sbomSha256Of(doc) {
  return documentSha256(doc)
}

export function buildSbomFromComponentsFile(componentsPath, { imageId, generatedAt = new Date().toISOString() } = {}) {
  const raw = JSON.parse(readFileSync(componentsPath, 'utf8'))
  return buildSbomDocument({ imageId, components: raw.components || [], generatedAt })
}

if (process.argv[1] && process.argv[1].endsWith('sbom.mjs')) {
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : null
  }
  const components = arg('--components')
  const imageId = arg('--image-id')
  const out = arg('--out')
  if (!components || !imageId || !out) {
    process.stderr.write('用法: node sbom.mjs --components <installed-components.json> --image-id <id> --out <sbom.json>\n')
    process.exit(2)
  }
  const doc = buildSbomFromComponentsFile(components, { imageId })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(doc, null, 2))
  process.stdout.write(`SBOM ${out} sha256=${sbomSha256Of(doc)}\n`)
}
