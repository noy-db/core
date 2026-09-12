/**
 * Stage B — a capsule declares which GROUPS it supports, and a service that
 * needs a missing one fails at `createNoydb()` with a typed error naming both
 * the group and what required it.
 *
 * ⚠️ THE NEGATIVE CASE CANNOT BE TESTED WITH A REAL CAPSULE YET, and saying so
 * is the honest state of this task. `enclave-aes` supports everything, and the
 * first capsule that refuses anything is `exclave-plain` in Stage C. So the
 * refusal is asserted against a STUB capability set.
 *
 * What that buys: the helper refuses correctly, with the right error type and
 * a message a reader can act on. What it does NOT buy: proof that any service
 * actually calls it. Per-service wiring lands in Stage C, where it can be
 * exercised by a capsule that genuinely lacks a group — wiring it now would be
 * unreachable code guarded by an untestable branch.
 */
import { describe, it, expect } from 'vitest'
import { capabilities } from '../src/capsule/index.js'
import { CapsuleNotSupportedError, type CapsuleGroup } from '../src/capsule/contract.js'
import { assertCapsuleSupports } from '../src/capsule/contract.js'

describe('capsule capabilities', () => {
  it('enclave-aes declares every group — it is the reference capsule', () => {
    const caps = capabilities()
    const every: CapsuleGroup[] = [
      'authenticate', 'seal', 'cipher', 'digest', 'sign', 'codec',
      'sealing', 'deterministic', 'classify',
    ]
    for (const g of every) expect(caps.has(g)).toBe(true)
  })

  // ⛔ This must be a RUNTIME refusal, not just a `ReadonlySet` type. A caller
  // holding a mutable set can "enable" a group the capsule does not implement,
  // and a JS consumer never sees the type. Note `Object.freeze` alone does NOT
  // do this for a Set — it guards own properties, not internal slots.
  it('refuses mutation at runtime — a caller cannot edit what a capsule claims', () => {
    const caps = capabilities() as Set<CapsuleGroup>
    expect(() => caps.add('nonsense' as CapsuleGroup)).toThrow(TypeError)
    expect(() => caps.delete('cipher')).toThrow(TypeError)
    expect(() => caps.clear()).toThrow(TypeError)
    // …and the claim is unchanged after the attempts.
    expect(capabilities().has('cipher')).toBe(true)
  })

  it('refuses a missing group with a typed error naming group and requirer', () => {
    const stub = new Set<CapsuleGroup>(['cipher', 'digest'])
    expect(() => assertCapsuleSupports(stub, 'seal', 'withTeam')).toThrow(CapsuleNotSupportedError)

    try {
      assertCapsuleSupports(stub, 'seal', 'withTeam')
      throw new Error('unreachable — assertCapsuleSupports should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(CapsuleNotSupportedError)
      const err = e as CapsuleNotSupportedError
      expect(err.group).toBe('seal')
      expect(err.requirer).toBe('withTeam')
      expect(err.code).toBe('CAPSULE_NOT_SUPPORTED')
      // The message must name BOTH, or a consumer reading a stack trace cannot
      // tell which service to drop or which capsule to change.
      expect(err.message).toContain('seal')
      expect(err.message).toContain('withTeam')
    }
  })

  it('permits a group the capsule does have', () => {
    const stub = new Set<CapsuleGroup>(['cipher'])
    expect(() => assertCapsuleSupports(stub, 'cipher', 'withAnything')).not.toThrow()
  })
})
