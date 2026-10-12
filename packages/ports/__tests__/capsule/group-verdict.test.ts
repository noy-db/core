/**
 * The false control for family#172's per-group guarantee.
 *
 * ⭐ WHY A PURE VERDICT RATHER THAN A FIXTURE CAPSULE. The guarantee has four
 * shapes and only two are reachable with a real capsule: `enclave-aes` supports
 * everything, so its run can never produce a refusal, and `exclave-plain` never
 * produces a working function in a group it declines. The two FAILING shapes
 * are therefore unreachable from either suite — which is precisely the position
 * the guarantee was in before this issue, green in both runs and tested in
 * neither.
 *
 * ⛔ A control that cannot fail is not a control. Separating the DECISION from
 * the MEASUREMENT makes both failing shapes expressible with no capsule, no
 * child vitest and no stub module — and the attribution is exact, because each
 * case names the one input that moved.
 *
 * ⚠️ This does NOT discharge the positive half. That is the real capsules'
 * runs: `self-conformance.test.ts` here, and `exclave-plain`'s own suite in
 * noy-db/capsule. A verdict function agreeing with itself proves nothing about
 * whether anything calls it — which was the original defect.
 */
import { describe, it, expect } from 'vitest'
import { groupVerdict, groupMemberNames, OPTIONAL_GROUPS } from '../../src/capsule/index.js'

const MEMBERS = ['a', 'b', 'c']

describe('groupVerdict — the per-group guarantee (family#172)', () => {
  it('✓ declared and nothing refuses', () => {
    expect(groupVerdict('classify', true, MEMBERS, MEMBERS)).toBeUndefined()
  })

  it('✓ undeclared and everything refuses', () => {
    expect(groupVerdict('classify', false, [], MEMBERS)).toBeUndefined()
  })

  it('⛔ FAILS a declared group whose functions refuse', () => {
    // The shape that passes construction and then fails at the first write:
    // a consumer asserts capabilities() at createNoydb() and is told yes.
    const why = groupVerdict('sealing', true, ['a'], MEMBERS)
    expect(why).toMatch(/declares "sealing"/)
    expect(why).toMatch(/2 of 3/)
    expect(why).toMatch(/\bb\b.*\bc\b/) // names WHICH refused, not just how many
  })

  it('⛔ FAILS an undeclared group whose functions work', () => {
    // capabilities() under-reporting itself — the reference capsule's own bug
    // in core#42, where it implemented per-record-keys and did not say so.
    const why = groupVerdict('deterministic', false, MEMBERS, MEMBERS)
    expect(why).toMatch(/does NOT declare "deterministic"/)
    expect(why).toMatch(/3 of 3/)
  })

  it('⛔ FAILS a MIXED group in BOTH directions — the case a consumer cannot reason about', () => {
    // One member works, two refuse. Neither "lacks the group" nor "has it" is
    // true, so no declaration can make this capsule conformant — which is why
    // it must fail whichever way it declares.
    expect(groupVerdict('classify', true, ['a'], MEMBERS)).toBeDefined()
    expect(groupVerdict('classify', false, ['a'], MEMBERS)).toBeDefined()
  })

  it('every optional group has members, so no case above is vacuous', () => {
    // ⚠️ The denominator is load-bearing: with an empty member list, "refused
    // === members.length" is 0 === 0 and an undeclared group passes without a
    // single call. That is the vacuous green this suite exists to refuse.
    for (const g of OPTIONAL_GROUPS) {
      expect(groupMemberNames(g).length, `"${g}" has no members — the guarantee is vacuous for it`)
        .toBeGreaterThan(0)
    }
  })
})
