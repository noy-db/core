/**
 * Stage B — the capsule BINDING, pinned at the manifest level.
 *
 * The seam is a build-time swap: a consumer sets a resolution condition and
 * their bundler picks a different implementation out of hub's `imports` map.
 * Two things make that work, and BOTH failed silently when first attempted
 * (measured 2026-09-12):
 *
 * 1. ⛔ `#capsule` must stay EXTERNAL in hub's build. tsup bundles by default,
 *    which would resolve `#capsule` at HUB's build time and bake the choice
 *    into what we ship — the consumer's condition could then never apply. The
 *    seam would compile, test green, and simply not be a seam.
 *
 * 2. ⛔ `#capsule`'s default target must be a file tsup actually EMITS. Without
 *    a tsup entry for it, the enclave is inlined into whichever entries use it,
 *    the map points at a path that does not exist, and `import '#capsule'`
 *    throws ERR_MODULE_NOT_FOUND — in a CONSUMER's install, not here. Source
 *    typechecks. Hub's suite runs from `src` and never notices.
 *
 * Neither is observable from source, which is why these assertions read the
 * manifest and the build config rather than importing anything.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hubDir = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${hubDir}package.json`, 'utf8')) as {
  exports: Record<string, unknown>
  imports?: Record<string, Record<string, string>>
}
const tsupConfig = readFileSync(`${hubDir}tsup.config.ts`, 'utf8')
const tsupEntries = readFileSync(`${hubDir}tsup.entries.mjs`, 'utf8')

describe('capsule binding', () => {
  it('declares #capsule with a default and both swap conditions', () => {
    const cap = pkg.imports?.['#capsule']
    expect(cap).toBeDefined()
    expect(cap!['noy-db:exclave-plain']).toBe('@noy-db/exclave-plain')
    expect(cap!['noy-db:enclave-pqc']).toBe('@noy-db/enclave-pqc')
    expect(cap!['default']).toBeDefined()
  })

  it('keeps #capsule external, or the swap is baked in at hub build time', () => {
    expect(tsupConfig).toMatch(/external:\s*\[[^\]]*'#capsule'/)
  })

  it("emits the default target as its own entry, or #capsule points at nothing", () => {
    const target = pkg.imports!['#capsule']!['default']!
    // './dist/kernel/enclave/index.js' -> 'kernel/enclave/index'
    const entryKey = target.replace(/^\.\/dist\//, '').replace(/\.js$/, '')
    expect(tsupEntries).toContain(`'${entryKey}'`)
  })

  it('publishes the contract, and does NOT publish the door', () => {
    expect(pkg.exports['./capsule']).toBeDefined()
    // The door reaches the bound implementation. Publishing it would let a
    // consumer import around the contract, which is the thing the seam exists
    // to prevent.
    expect(Object.keys(pkg.exports)).not.toContain('./capsule/index')
    expect(JSON.stringify(pkg.exports)).not.toContain('capsule/index')
  })
})
