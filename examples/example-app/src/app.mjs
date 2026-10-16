export function greeting(name = 'world') {
  const value = String(name).trim()
  return `Hello, ${value || 'world'}!`
}

export function normalizeName(value) {
  return String(value ?? '').trim().slice(0, 80)
}
