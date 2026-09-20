/**
 * core#58 — `KeyringFile.clearance` is written, derived, authenticated, and
 * advisory.
 *
 * ## What was wrong
 *
 * `clearance` was declared on a PUBLISHED type and read and written by nothing;
 * `effectiveClearance`, the only implementation of what it means, had no
 * caller. The format posed a question no code answered, on either side.
 *
 * ## The three properties that make wiring it safe
 *
 *  1. **DERIVED, not independent** — computed from the DEK slot names in the
 *     very object being stamped, at every one of the thirteen construction
 *     sites, via `stampAuthority`. A value computed once at grant time would go
 *     stale the moment a tier DEK was added or revoked.
 *  2. **AUTHENTICATED** — bound into `rosterCanonical`, so a store cannot forge
 *     it. Without this it would be an attacker-controlled access-shaped number.
 *  3. **BACKWARD COMPATIBLE** — bound with a CONDITIONAL SPREAD. A keyring
 *     written before this field existed must produce the byte-identical
 *     canonical it always did, or its tag fails and its vault will not open.
 *
 * ⛔ Property 3 is the one with teeth, and the test for it is the third case
 * below. `file.clearance ?? null` — the shape the older optional fields use —
 * would brick every existing vault. `roster-tag.ts` carries the same warning
 * for `roster_epoch`, which paid for it first.
 *
 * ⚠️ It is ADVISORY. `assertTierAccess` remains the gate; nothing here may
 * become a privilege decision.
 */
import { describe, it, expect } from 'vitest'
import { rosterCanonical, stampAuthority } from '../src/with-party/team/roster-tag.js'
import { effectiveClearance, keyringClearance } from '../src/with-party/team/tiers.js'

describe('core#58 — clearance is derived, authenticated and advisory', () => {
  it('keyringClearance is the max tier over ALL collections; effectiveClearance is per collection', () => {
    const slots = ['docs', 'docs#1', 'docs#3', 'ledger', 'ledger#2']

    expect(effectiveClearance(slots, 'docs')).toBe(3)
    expect(effectiveClearance(slots, 'ledger')).toBe(2)
    expect(effectiveClearance(slots, 'absent')).toBe(0)

    // ⭐ The distinction core#58 turned on: the field wants the GLOBAL max.
    expect(keyringClearance(slots)).toBe(3)
    expect(keyringClearance(['docs', 'ledger'])).toBe(0)
    expect(keyringClearance([])).toBe(0)
  })

  it('stampAuthority derives clearance from the deks it is stamping', () => {
    const stamped = stampAuthority(
      { user_id: 'u', deks: { docs: 'w', 'docs#1': 'w', 'docs#4': 'w' } },
      7,
    )
    expect(stamped.clearance).toBe(4)
    expect(stamped.roster_epoch).toBe(8)

    // Cannot disagree with its own slots — that is the anti-drift property.
    expect(stamped.clearance).toBe(keyringClearance(Object.keys(stamped.deks)))
  })

  it('⛔ a pre-existing keyring with NO clearance canonicalises byte-identically', () => {
    const legacy = {
      user_id: 'u', role: 'owner' as const, permissions: {}, granted_by: 'u',
      deks: { docs: 'w' }, roster_epoch: 3,
    }

    // The string a pre-clearance build produced is exactly the one with the
    // field absent. If this ever differs, every existing vault stops opening.
    const withoutField = rosterCanonical(legacy)
    // ⚠️ The cast is load-bearing, not laziness: `exactOptionalPropertyTypes`
    // forbids passing an explicit `undefined` for an optional property, and the
    // case being tested is exactly the one the type system forbids and the WIRE
    // permits — a store returns JSON, and `{"clearance": undefined}` is not
    // expressible there but `JSON.parse` + a hand-built object is. `stable()`
    // filters `undefined` entries, and this asserts that it does.
    const withUndefined = rosterCanonical(
      { ...legacy, clearance: undefined } as unknown as typeof legacy,
    )
    expect(withUndefined).toBe(withoutField)
    expect(withoutField).not.toMatch(/clearance/)

    // And a present value DOES change it — otherwise binding it is a no-op and
    // the forgery protection below would be vacuous.
    expect(rosterCanonical({ ...legacy, clearance: 0 })).not.toBe(withoutField)
  })

  it('a forged clearance changes the canonical, so the tag stops verifying', () => {
    const honest = {
      user_id: 'u', role: 'viewer' as const, permissions: {}, granted_by: 'owner',
      deks: { docs: 'w', 'docs#1': 'w' }, roster_epoch: 2, clearance: 1,
    }
    // A store raising the number it can see, without the keys to match.
    const forged = { ...honest, clearance: 9 }
    expect(rosterCanonical(forged)).not.toBe(rosterCanonical(honest))
  })
})
