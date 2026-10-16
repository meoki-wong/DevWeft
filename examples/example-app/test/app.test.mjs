import test from 'node:test'
import assert from 'node:assert/strict'
import { greeting, normalizeName } from '../src/app.mjs'

test('greeting uses a safe default and trims a supplied name', () => {
  assert.equal(greeting(), 'Hello, world!')
  assert.equal(greeting(' Ada '), 'Hello, Ada!')
})

test('normalizeName caps input length and handles null values', () => {
  assert.equal(normalizeName(null), '')
  assert.equal(normalizeName('  DevWeft  '), 'DevWeft')
  assert.equal(normalizeName('x'.repeat(100)).length, 80)
})
