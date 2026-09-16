import type { CapsuleGroup } from '../contract.js'

/**
 * `enclave-aes` supports every group. It is the REFERENCE capsule — the
 * behaviour every other implementation is compared against, and the one hub
 * ships so that `npm install @noy-db/hub` alone is a working noy-db.
 *
 * An `exclave-*` refuses `authenticate` and `seal` (no secret, no key
 * hierarchy — the store's own IAM is the authority) and may refuse the
 * optional groups. That asymmetry is what the prefix means, and the
 * conformance suite asserts it from the package name rather than trusting a
 * declaration.
 *
 * Frozen so a caller cannot edit what a capsule claims to support: a mutable
 * set would let a service "enable" a group by adding to it, which is exactly
 * the confidently-wrong failure the typed refusal exists to prevent.
 */
/**
 * ⛔ `Object.freeze` does NOT make a Set immutable — it guards own properties,
 * not internal slots, so `frozen.add(x)` still succeeds. Measured 2026-09-12,
 * against a test that asserted otherwise and failed. The mutators are replaced
 * so the refusal is real at runtime, not just in the type.
 *
 * Why it has to be real: a caller holding a mutable capability set can "enable"
 * a group the capsule does not implement, and the next thing that happens is a
 * primitive being called on a capsule that has none. `ReadonlySet` alone is a
 * compile-time claim, and a JS consumer never sees it.
 */
function sealedSet<T>(items: readonly T[]): ReadonlySet<T> {
  const set = new Set<T>(items)
  const refuse = (): never => {
    throw new TypeError(
      'capabilities() is immutable — a capsule\'s declared groups cannot be edited by a caller',
    )
  }
  set.add = refuse as never
  set.delete = refuse as never
  set.clear = refuse as never
  return Object.freeze(set)
}

const ALL: ReadonlySet<CapsuleGroup> = sealedSet<CapsuleGroup>([
  'authenticate',
  'seal',
  'cipher',
  'digest',
  'sign',
  'codec',
  'sealing',
  'deterministic',
  'classify',
  // ⭐ ADDED 2026-09-16 (core#42). `enclave-aes` implements `wrapCek` and
  // `unwrapCek`, so advertising the group is the truthful `capabilities()`.
  // The nine-member set was the REFERENCE capsule under-reporting itself:
  // "supports every group" was the documented intent above, and it had been
  // untrue since `per-record-keys` existed as a refusable thing.
  // ⛔ This is a published behaviour change — `capabilities()` returns one
  // more member to any consumer that inspects it. Release-noted by name.
  'per-record-keys',
])

export function capabilities(): ReadonlySet<CapsuleGroup> {
  return ALL
}
