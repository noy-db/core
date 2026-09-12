/**
 * #16 — hub's REAL capsule surface must satisfy `EnclaveModule`.
 *
 * ⛔ THIS IS THE DURABLE FIX, and the reason it exists is worth stating.
 * `EnclaveModule` is declared structurally so a fork's capsule is shape-checked
 * rather than required to be hub's own module. That is right — but it means
 * nothing verifies the declaration against the implementation it describes, and
 * the declaration silently drifted: `buildTombstone` was declared `(version,
 * actor)` while hub's takes `(ref, version, actor)`.
 *
 * The drift was invisible for two compounding reasons:
 *   1. The kit lived in `test-harnesses/`, whose typecheck was not part of the
 *      workspace `typecheck` task. Nothing checked it.
 *   2. The case that used it called `buildTombstone(3, 'user-1')` and PASSED —
 *      `3` spread as the ref yields `{}`, `'user-1'` became the version, and
 *      `isTombstone` returned true anyway because it inspects only
 *      `_data`/`_cek`/`_del`. Green, and proving nothing.
 *
 * A published kit whose types are wrong is worse than one with no types: an
 * out-of-tree capsule author implements the signature the kit declares, and
 * their capsule then fails against hub for a reason the suite never warned of.
 *
 * This assertion is COMPILE-TIME. If it ever fails, do not cast it away —
 * update `EnclaveModule` to match hub, and check whether a case was passing
 * for the wrong reason in the meantime.
 *
 * ⚠️ WHAT IT DOES NOT CATCH, measured rather than assumed. `EnclaveModule`
 * declares its members with METHOD SHORTHAND, which TypeScript checks
 * BIVARIANTLY — so parameter-arity drift passes this assignment in both
 * directions. Verified by reintroducing the exact #16 bug (`buildTombstone`
 * declared with 2 parameters against hub's 3): this line stayed green and the
 * CALL SITES in `enclave-cases.ts` were what failed.
 *
 * So the coverage splits:
 *   - this assertion catches a MISSING member, a wrong parameter TYPE, and a
 *     wrong return type;
 *   - the call sites catch ARITY.
 *
 * Both are needed, and a member this kit never calls is covered by neither.
 * Converting `EnclaveModule` to property syntax (`buildTombstone: (…) => …`)
 * would make this line strict — worth doing if the kit ever declares members
 * it does not exercise.
 */
import { describe, it, expect } from 'vitest'
import type { EnclaveKey } from '@noy-db/hub'
import * as hubCapsule from '../../hub/src/capsule/index.js'
import type { EnclaveModule } from '../src/index.js'

// The assignment IS the test: hub's module must satisfy the kit's declaration.
// A mismatched arity, parameter type or return type fails to compile here.
const _surfaceIsAssignable: EnclaveModule<EnclaveKey> = hubCapsule

describe('#16 — the kit describes the surface it tests', () => {
  it("hub's capsule satisfies EnclaveModule (enforced at compile time)", () => {
    // The runtime half is trivial by design; the compile-time binding above is
    // the assertion. This keeps the file a real test rather than a lone
    // type-only module a test runner would skip.
    expect(typeof _surfaceIsAssignable.buildTombstone).toBe('function')
    expect(typeof _surfaceIsAssignable.generateDEK).toBe('function')
  })
})
