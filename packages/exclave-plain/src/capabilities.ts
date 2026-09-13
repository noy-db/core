/**
 * What this capsule implements, and what it refuses.
 *
 * The refusals are the product, not a shortfall. `authenticate` and `seal` are
 * absent because there is no secret: unlock always succeeds and your store's
 * IAM is the authority. The conformance kit asserts that from the PACKAGE
 * NAME — an `exclave-*` that supported `authenticate` would fail the prefix
 * rule — which is what makes the prefix a trust posture rather than a naming
 * convention.
 */
import type { CapsuleGroup } from '@noy-db/hub/capsule'

const GROUPS: readonly CapsuleGroup[] = [
  // Real, with no cipher: bodies pass through with an integrity stamp.
  'cipher',
  // Identical to every capsule — hashes are not secrets.
  'digest',
  // Ed25519, shared with enclave-aes.
  'sign',
  // hub's envelope format, bound to this capsule's primitives.
  'codec',
]

/**
 * ⚠️ A SEALED set. `Object.freeze` does NOT make a `Set` immutable — it guards
 * own properties, not internal slots, so a frozen Set still accepts `.add()`.
 * That was measured in Stage B: the test asserting immutability failed, which
 * is how it was found. Replacing the mutators is what actually holds, and it
 * matters here more than anywhere: a caller who could `add('seal')` would turn
 * a refusal into a silent wrong answer at the first write.
 */
function sealedSet(values: readonly CapsuleGroup[]): ReadonlySet<CapsuleGroup> {
  const set = new Set(values)
  const deny = (op: string) => () => {
    throw new Error(
      `exclave-plain: capabilities() is not mutable (${op}). A capsule's ` +
      'supported groups are fixed at build time; enabling one it does not ' +
      'implement would fail at the first write instead of at construction.',
    )
  }
  return Object.freeze(Object.assign(set, {
    add: deny('add'), delete: deny('delete'), clear: deny('clear'),
  })) as ReadonlySet<CapsuleGroup>
}

const CAPABILITIES = sealedSet(GROUPS)

export function capabilities(): ReadonlySet<CapsuleGroup> {
  return CAPABILITIES
}
