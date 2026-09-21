/**
 * The drift check for a contract that is duplicated ON PURPOSE (core#42).
 *
 * ⭐ WHY THIS FILE EXISTS. `src/enclave-cases.ts` declares `EnclaveModule`
 * STRUCTURALLY rather than importing hub's type, and that decision is sound
 * and documented: a fork's capsule is a different object, shape-checked, never
 * required to be hub's own module. What was missing is anything that checks
 * the copy still matches the original.
 *
 * It had drifted THREE times before anything compiled the two against each
 * other, and the second and third were found only while fixing the first:
 *
 *   1. `writeEnvelopeBody`'s identity omitted `version`, which hub's
 *      `RecordIdentity` requires.
 *   2. `EnclaveNotSupportedError.group` could not name `classify`, which the
 *      contract explicitly says a capsule may refuse.
 *   3. `per-record-keys` was a `ConformanceGroup` here and NOT a `CapsuleGroup`
 *      at all — `wrapCek`/`unwrapCek` are real refusable primitives that no
 *      group covered.
 *
 * ⛔ The durable rule, now a requirement on every contract the ceremony thread
 * authors (family#29): a deliberately duplicated contract ships its drift
 * check IN THE SAME COMMIT, never later. Drifts do not arrive one at a time.
 *
 * ⚠️ These are COMPILE-TIME assertions. They fail by not typechecking, which
 * means this file is only load-bearing while `tsconfig.tests.json` includes
 * `__tests__` — vitest transpiles without checking, so running the suite
 * proves nothing here. That config is the other half of this test.
 */
import { describe, it, expect } from 'vitest'
import type { CapsuleGroup } from '@noy-db/hub/capsule'
import type { RecordIdentity } from '@noy-db/hub'
import * as reference from '../../../hub/src/capsule/index.js'
import type { ConformanceGroup, EnclaveModule } from '../../src/capsule/index.js'

/** Compile-time assertion: `T` must be assignable to `U`. */
type Assert<T extends U, U> = T

// ── 1. Every ConformanceGroup is a real CapsuleGroup ──────────────────────
// Red if a group is renamed or removed from hub, or invented here. This is
// exactly what was false for `per-record-keys` until core#42 added it to
// CapsuleGroup.
type _GroupsAreReal = Assert<ConformanceGroup, CapsuleGroup>

// ── 2. The structural identity accepts hub's real RecordIdentity ──────────
// Red if hub adds a required field the kit's structural copy does not carry —
// which is how the missing `version` shipped. Deliberately this direction:
// hub's identity is what a capsule will actually RECEIVE, so it must satisfy
// the parameter the kit tells authors to implement.
type KitIdentity = Parameters<EnclaveModule<CryptoKey>['writeEnvelopeBody']>[0]
type _IdentityAcceptsReal = Assert<RecordIdentity, KitIdentity>

// ── 3. The reference capsule satisfies the kit's structural contract ──────
// The broadest of the three, and the one that catches a signature change
// anywhere in the module. If hub's own capsule stops satisfying the shape this
// kit asks third parties for, the kit is asking for the wrong shape.
type _ReferenceSatisfies = Assert<typeof reference, EnclaveModule<CryptoKey>>

describe('capsule contract drift', () => {
  // A runtime body so the file is a test rather than a silently-skipped
  // module, and so `vitest run` reports it. The assertions above are the
  // actual content; this asserts the reference module is really present,
  // which is what makes the type-level checks non-vacuous.
  it('the reference capsule exports the surface the kit asserts against', () => {
    expect(typeof reference.writeEnvelopeBody).toBe('function')
    expect(typeof reference.wrapCek).toBe('function')
    expect(typeof reference.unwrapCek).toBe('function')
    expect(typeof reference.capabilities).toBe('function')
  })

  // ⚠️ THIS ASSERTION READS hub's DIST, not its source, and the two disagree
  // until hub is rebuilt. `hub/src/capsule/index.ts:122` re-exports
  // `capabilities` from `#capsule`, which hub's `imports` map points at
  // `./dist/...` — so the type-level assertions above see SOURCE while this one
  // sees BUILD OUTPUT. It passes in CI because `test` depends on `build`;
  // locally it fails against a stale `dist` and the message looks like the
  // source edit did not take. Rebuild hub before believing it.
  it('capabilities() advertises per-record-keys — the group wrapCek/unwrapCek live in', () => {
    // The reference capsule implements both primitives, so it must advertise
    // the group. It did not until core#42: the reference was under-reporting
    // itself, and "supports every group" was untrue in its own docstring.
    expect([...reference.capabilities()]).toContain('per-record-keys')
  })
})
