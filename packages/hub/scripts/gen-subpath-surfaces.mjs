#!/usr/bin/env node
/**
 * Generate the per-subpath surface goldens under `__tests__/surfaces/`.
 *
 * Run once to create a baseline, and again — deliberately, in a reviewed
 * commit — when a subpath's surface is MEANT to change. Never run it to make
 * a failing test pass; that is the one use it must not have.
 *
 * Enumerates VALUE exports at runtime from the built `dist`. Type-only exports
 * are not visible at runtime and are NOT covered here — the hand-written
 * per-subpath goldens (`to-surface.golden.json` and friends) parse source and
 * cover both. The limit is stated in the generic test too, so nobody reads
 * this as freezing the whole surface.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(ROOT, '__tests__', 'surfaces')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const subpaths = Object.keys(pkg.exports)
  .filter((k) => k.startsWith('./') && !k.endsWith('.json'))
  .sort()

mkdirSync(OUT, { recursive: true })

const written = []
const failed = []
for (const sub of subpaths) {
  const target = pkg.exports[sub].default
  try {
    const mod = await import(join(ROOT, target))
    const values = Object.keys(mod).sort()
    const name = sub.slice(2).replace(/\//g, '-')
    writeFileSync(
      join(OUT, `${name}.json`),
      JSON.stringify({ subpath: `@noy-db/hub${sub.slice(1)}`, entry: target, values }, null, 2) + '\n',
    )
    written.push(`${name} (${values.length})`)
  } catch (err) {
    failed.push(`${sub}: ${err.message.split('\n')[0]}`)
  }
}

console.log(`wrote ${written.length} surface goldens to __tests__/surfaces/`)
if (failed.length > 0) {
  console.error(`\n${failed.length} subpath(s) could not be imported:`)
  for (const f of failed) console.error(`  ${f}`)
  process.exit(1)
}
