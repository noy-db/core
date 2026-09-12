/**
 * Stage B — the door is transparent.
 *
 * Every symbol reachable through the enclave barrel must be reachable through
 * `capsule/index.ts` with the SAME IDENTITY, not a copy. If the two ever
 * diverge, a consumer importing through one path gets a different function
 * object than one importing through the other, and `instanceof` / identity
 * checks silently stop matching — the #660 class, where a duplicated
 * declaration made two nominally distinct types out of one source.
 *
 * Identity is the assertion that matters. A test comparing only NAMES would
 * pass against a door that re-implemented every symbol.
 */
import { describe, it, expect } from 'vitest'
import * as door from '../src/capsule/index.js'
import * as barrel from '../src/kernel/enclave/index.js'

describe('capsule door', () => {
  it('re-exports every runtime value the enclave barrel exports, by identity', () => {
    const barrelKeys = Object.keys(barrel).sort()
    expect(barrelKeys.length).toBeGreaterThan(0)
    expect(Object.keys(door).sort()).toEqual(expect.arrayContaining(barrelKeys))
    for (const k of barrelKeys) {
      expect((door as Record<string, unknown>)[k]).toBe((barrel as Record<string, unknown>)[k])
    }
  })

  it('adds the contract surface on top of the barrel', () => {
    expect(typeof door.CapsuleNotSupportedError).toBe('function')
  })
})
