/**
 * family#156 — which hub feature needs which capsule group, decided as a pure
 * function so the refusal can be tested at all.
 *
 * ⭐ WHY PURE. `enclave-aes` supports every group, so NO integration path in
 * this repo can reach a refusal — the only capsule that refuses anything lives
 * in another repo. A check wired without a testable decision is exactly the
 * shape family#172 had to fix: `assertGroupRefuses` existed, was correct, and
 * ran only where it could not fail. So the decision is tested here against stub
 * sets, and `capsule-requirements-wiring.test.ts` proves something calls it.
 *
 * ⚠️ `authenticate` and `seal` appear in NEITHER table, by measurement:
 * `deriveKey`/`wrapKey`/`unwrapKey` are called only from the keyring unlock
 * chain, never from a field form. See the module docstring.
 */
import { describe, it, expect } from 'vitest'
import {
  fieldGroupRequirements,
  serviceGroupRequirements,
  assertFieldsSupported,
  assertServicesSupported,
} from '../src/kernel/capsule-requirements.js'
import { CapsuleNotSupportedError, type CapsuleGroup } from '../src/capsule/contract.js'

/** What the shipped exclave declares — cipher, digest, sign, codec. */
const EXCLAVE = new Set<CapsuleGroup>(['cipher', 'digest', 'sign', 'codec'])
const EVERYTHING = new Set<CapsuleGroup>([
  'authenticate', 'seal', 'cipher', 'digest', 'sign', 'codec',
  'sealing', 'deterministic', 'classify', 'per-record-keys',
])

const groupsOf = (rs: ReadonlyArray<readonly [CapsuleGroup, string]>): CapsuleGroup[] =>
  [...new Set(rs.map(([g]) => g))].sort()

describe('serviceGroupRequirements (refusal point 1)', () => {
  it('names per-record-keys for blobs, cargo and tiers — the three that wrap a CEK', () => {
    // Derived from the call sites: `wrapCek`/`unwrapCek` outside capsule/ appear
    // in exactly with-shape/blobs, with-cargo and with-audit/tiers.
    for (const key of ['blobsStrategy', 'cargoStrategy', 'tiersStrategy']) {
      expect(groupsOf(serviceGroupRequirements({ [key]: {} }))).toEqual(['per-record-keys'])
    }
  })

  it('names classify for the classified strategy', () => {
    expect(groupsOf(serviceGroupRequirements({ classifiedStrategy: {} }))).toEqual(['classify'])
  })

  it('requires nothing of a vault that enables nothing', () => {
    // The control. Without it, a predicate returning every group for every
    // input would pass every case above.
    expect(serviceGroupRequirements({ store: {}, user: 'u', secret: 's' })).toEqual([])
  })

  it('names the OPTION KEY in the requirer, so the error says what to remove', () => {
    const [[, requirer]] = serviceGroupRequirements({ blobsStrategy: {} }) as [[CapsuleGroup, string]]
    expect(requirer).toContain('blobsStrategy')
  })

  it('⛔ refuses an enabled service the capsule cannot honour', () => {
    expect(() => assertServicesSupported({ blobsStrategy: {} }, EXCLAVE))
      .toThrowError(expect.objectContaining({ code: 'CAPSULE_NOT_SUPPORTED', group: 'per-record-keys' }))
    expect(() => assertServicesSupported({ blobsStrategy: {} }, EVERYTHING)).not.toThrow()
  })
})

describe('fieldGroupRequirements (refusal point 2)', () => {
  it('sensitiveFields need sealing, in either shape the option arrives in', () => {
    // ⚠️ Set AND array: `deterministicFields` is a declared array while
    // `sensitiveFields` is frozen into a Set at construction. A `length` check
    // alone reads undefined on the Set and concludes "nothing declared".
    expect(groupsOf(fieldGroupRequirements('c', { sensitiveFields: ['ssn'] }))).toEqual(['sealing'])
    expect(groupsOf(fieldGroupRequirements('c', { sensitiveFields: new Set(['ssn']) }))).toEqual(['sealing'])
  })

  it('deterministicFields need deterministic', () => {
    expect(groupsOf(fieldGroupRequirements('c', { deterministicFields: ['email'] }))).toEqual(['deterministic'])
  })

  it('⭐ perRecordKeys needs per-record-keys — a COLLECTION option no service implies', () => {
    // The delta the ruling's three services missed: a collection can mint and
    // wrap a CEK on every write with blobs, cargo and tiers all absent.
    expect(groupsOf(fieldGroupRequirements('c', { perRecordKeys: true }))).toEqual(['per-record-keys'])
    expect(fieldGroupRequirements('c', { perRecordKeys: false })).toEqual([])
  })

  it("storage:'recoverable' needs sealing; 'digest-only' needs classify; equatable needs classify", () => {
    const g = (byField: Record<string, { storage: string; equatable?: boolean }>): CapsuleGroup[] =>
      groupsOf(fieldGroupRequirements('users', { classifiedByField: byField }))
    expect(g({ ssn: { storage: 'recoverable' } })).toEqual(['sealing'])
    expect(g({ password: { storage: 'digest-only' } })).toEqual(['classify'])
    expect(g({ email: { storage: 'never', equatable: true } })).toEqual(['classify'])
  })

  it("⭐ storage:'never' alone needs NOTHING — the one form an exclave can honour", () => {
    // Refusing it would make the only storage form a plaintext capsule can
    // serve unusable, which inverts the point of the check.
    expect(fieldGroupRequirements('users', { classifiedByField: { note: { storage: 'never' } } })).toEqual([])
  })

  it('requires nothing of a collection that declares no protected field', () => {
    expect(fieldGroupRequirements('plain', {})).toEqual([])
    expect(fieldGroupRequirements('plain', { sensitiveFields: [], deterministicFields: [] })).toEqual([])
  })

  it('names collection AND field in the requirer', () => {
    const [[, requirer]] = fieldGroupRequirements('users', {
      classifiedByField: { password: { storage: 'digest-only' } },
    }) as [[CapsuleGroup, string]]
    expect(requirer).toContain('users')
    expect(requirer).toContain('password')
  })

  it('⛔ refuses a declared field the capsule cannot honour', () => {
    expect(() => assertFieldsSupported('users', { deterministicFields: ['email'] }, EXCLAVE))
      .toThrowError(expect.objectContaining({ code: 'CAPSULE_NOT_SUPPORTED', group: 'deterministic' }))
    expect(() => assertFieldsSupported('users', { deterministicFields: ['email'] }, EVERYTHING)).not.toThrow()
  })

  it('the error is a CapsuleNotSupportedError, catchable by class across the seam', () => {
    // family#156's first half re-exported it at `@noy-db/hub/capsule` for
    // exactly this: one class, so `instanceof` holds on both sides of the door.
    try {
      assertFieldsSupported('users', { sensitiveFields: ['ssn'] }, EXCLAVE)
      expect.unreachable('must refuse')
    } catch (e) {
      expect(e).toBeInstanceOf(CapsuleNotSupportedError)
    }
  })
})
