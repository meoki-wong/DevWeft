#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyEvidencePack } from '../testing/evidence-pack.js'

function valueAfter(args, flag) {
  const index = args.indexOf(flag)
  return index < 0 ? null : args[index + 1] || null
}

try {
  const path = valueAfter(process.argv.slice(2), '--file')
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/verify-evidence-pack.mjs --file <evidence-pack.zip>\n')
  } else if (!path) {
    process.stdout.write('Usage: node scripts/verify-evidence-pack.mjs --file <evidence-pack.zip>\n')
    process.exitCode = 2
  } else {
    const absolute = resolve(path)
    const size = statSync(absolute).size
    if (!size || size > 50 * 1024 * 1024) throw new Error('Evidence pack must be between 1 byte and 50 MiB')
    const result = verifyEvidencePack(readFileSync(absolute))
    process.stdout.write(`${JSON.stringify({ ...result, path: absolute })}\n`)
  }
} catch (error) {
  process.stderr.write(`Evidence pack verification failed: ${error.message}\n`)
  process.exitCode = 1
}
