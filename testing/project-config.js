import Ajv from 'ajv'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(readFileSync(path.join(root, 'schemas', 'project-config.schema.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: true })
const validateSchema = ajv.compile(schema)

/** Validate a project config and return structured, stable diagnostics. */
export function validateProjectConfig(value) {
  const valid = validateSchema(value)
  const errors = (validateSchema.errors || []).map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message || 'is invalid',
  }))

  if (Array.isArray(value?.checks)) {
    for (const key of ['id', 'name']) {
      const seen = new Set()
      value.checks.forEach((check, index) => {
        const item = check?.[key]
        if (typeof item !== 'string' || !item) return
        if (seen.has(item)) errors.push({ path: `/checks/${index}/${key}`, keyword: 'unique', message: `duplicates ${key} "${item}"` })
        seen.add(item)
      })
    }
  }

  return { valid: Boolean(valid) && errors.length === 0, errors }
}

export function projectConfigSchema() {
  return structuredClone(schema)
}
