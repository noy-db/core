/**
 * @noy-db/test-capsule-conformance — the contract suite every capsule passes.
 *
 * ONE kit, two case sets:
 *
 *  - `contract-cases` — the seam: the prefix rule, the declared capability set,
 *    cipher round-trip and AAD binding, digest, sign, and the authenticate +
 *    seal pair.
 *  - `enclave-cases` — the deep envelope behaviour: body round-trip, tombstone
 *    semantics, body-helper discriminants, key lifecycle, and the
 *    group-consistency guarantee (every function in an optional group refuses,
 *    or none does — never a mix).
 *
 * ⭐ These were TWO kits until 2026-09-12. `test-harnesses/enclave-conformance`
 * held the envelope cases as a `private: true` harness; a second, published one
 * was written for the capsule seam without noticing. They are merged here
 * because a capsule author outside this repo needs the envelope cases too, and
 * a private harness cannot give them that — and because two suites for one
 * contract is how a case ends up living in neither.
 *
 * ⛔ THE DEPENDENCY EDGE RUNS KIT → HUB, AND ONLY THAT WAY. Hub must NOT
 * depend on this package: hub ↔ kit is a turbo build cycle, measured — `pnpm
 * build` refuses it outright. This is the same shape as
 * `@noy-db/test-adapter-conformance`, which depends on hub while hub does not
 * depend on it, and it is why the reference capsule's own conformance run
 * lives HERE rather than in hub's test suite.
 *
 * `EnclaveModule` is still declared STRUCTURALLY rather than imported: a
 * fork's capsule is a different object, shape-checked, never required to be
 * hub's own module. Only `EncryptedEnvelope` and `EnclaveNotSupportedError`
 * come from hub, through a PEER range — so a capsule author pins their own
 * hub version rather than the one this kit was built against.
 */
export { runCapsuleConformance } from './contract-cases.js'
export type { CapsuleUnderTest, CapsuleGroup, ConformanceOptions } from './contract-cases.js'

export { runEnclaveConformance, assertGroupRefuses } from './enclave-cases.js'
export type {
  EnclaveModule,
  EnclaveConformanceOptions,
  ConformanceGroup,
} from './enclave-cases.js'

