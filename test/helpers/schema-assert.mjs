/**
 * JSON Schema draft 2020-12 子集校验（M0 契约测试，不引入新依赖）。
 * 支持: type/const/enum/required/properties/additionalProperties/
 * items/minItems/uniqueItems/minimum/minLength/pattern/anyOf/format=date-time/$ref #/$defs
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

export function validateSchema(schema, data, root = schema) {
  const errors = []
  walk(schema, data, '$', root, errors)
  return errors
}

export function assertValid(schema, data, root = schema) {
  const errors = validateSchema(schema, data, root)
  if (errors.length) {
    throw new Error(`schema validation failed:\n${errors.join('\n')}`)
  }
}

export function assertInvalid(schema, data, root = schema) {
  const errors = validateSchema(schema, data, root)
  if (errors.length === 0) {
    throw new Error('expected schema validation to fail')
  }
}

function walk(schema, data, path, root, errors) {
  if (!schema || typeof schema !== 'object') return
  if (schema.$ref) {
    walk(resolveRef(root, schema.$ref), data, path, root, errors)
    return
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub) => {
      const nested = []
      walk(sub, data, path, root, nested)
      return nested.length === 0
    })
    if (!ok) errors.push(`${path}: no anyOf branch matched`)
    return
  }
  if (Object.hasOwn(schema, 'const') && data !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: expected enum ${schema.enum.join('|')}`)
  }
  if (schema.type) {
    if (!typeOk(schema.type, data)) {
      errors.push(`${path}: expected type ${schema.type}`)
      return
    }
  }
  if (schema.type === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) {
      errors.push(`${path}: minLength ${schema.minLength}`)
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      errors.push(`${path}: pattern mismatch`)
    }
    if (schema.format === 'date-time' && !DATETIME_RE.test(data)) {
      errors.push(`${path}: expected UTC ISO-8601 date-time`)
    }
    if (schema.format === 'uuid' && !UUID_RE.test(data)) {
      errors.push(`${path}: expected uuid`)
    }
  }
  if (schema.type === 'integer') {
    if (schema.minimum != null && data < schema.minimum) {
      errors.push(`${path}: minimum ${schema.minimum}`)
    }
  }
  if (schema.type === 'array' && Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) {
      errors.push(`${path}: minItems ${schema.minItems}`)
    }
    if (schema.uniqueItems) {
      const seen = new Set(data.map((x) => JSON.stringify(x)))
      if (seen.size !== data.length) errors.push(`${path}: uniqueItems`)
    }
    if (schema.items) {
      data.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, root, errors))
    }
  }
  if (schema.type === 'object' && data && typeof data === 'object' && !Array.isArray(data)) {
    const props = schema.properties || {}
    for (const key of schema.required || []) {
      if (!Object.hasOwn(data, key)) errors.push(`${path}: missing required ${key}`)
    }
    for (const key of Object.keys(data)) {
      if (props[key]) walk(props[key], data[key], `${path}.${key}`, root, errors)
      else if (schema.additionalProperties === false) {
        errors.push(`${path}: unknown field ${key}`)
      }
    }
  }
}

function typeOk(type, data) {
  switch (type) {
    case 'object':
      return data !== null && typeof data === 'object' && !Array.isArray(data)
    case 'array':
      return Array.isArray(data)
    case 'string':
      return typeof data === 'string'
    case 'integer':
      return Number.isInteger(data)
    case 'number':
      return typeof data === 'number' && Number.isFinite(data)
    case 'boolean':
      return typeof data === 'boolean'
    case 'null':
      return data === null
    default:
      return false
  }
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`)
  let cur = root
  for (const part of ref.slice(2).split('/')) {
    cur = cur[part]
    if (cur == null) throw new Error(`unresolved $ref ${ref}`)
  }
  return cur
}
