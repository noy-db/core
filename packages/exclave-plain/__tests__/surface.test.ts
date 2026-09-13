/**
 * The binding contract: hub's capsule door names ~97 values and imports them
 * from `#capsule`. If this package is missing even one, a consumer who sets
 * the `noy-db:exclave-plain` condition gets a module-resolution failure at
 * import time — in THEIR install, not in our CI.
 *
 * ⚠️ THE GOLDEN IS READ FROM HUB, not copied. A copied list would drift the
 * moment hub adds an export, and the drift would be invisible here and fatal
 * there. This is the same reason the conformance kit exists: the contract has
 * one definition or it has none.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as exclave from '../src/index.js'

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../hub/__tests__/enclave-surface.golden.json', import.meta.url)),
    'utf8',
  ),
) as { values: string[] }

describe('exclave-plain satisfies hub\'s capsule surface', () => {
  it('exports every value the door names', () => {
    const mine = new Set(Object.keys(exclave))
    const missing = golden.values.filter(name => !mine.has(name))
    expect(missing).toEqual([])
  })

  it('exports nothing the door does not name', () => {
    // Not pedantry: an extra export here is a name hub will not re-export, so
    // it is dead weight in the published artefact and a false promise to
    // anyone who finds it.
    const expected = new Set(golden.values)
    const extra = Object.keys(exclave).filter(name => !expected.has(name))
    expect(extra).toEqual([])
  })
})
