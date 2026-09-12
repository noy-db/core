/**
 * The capsule seam (capsule seam spec, Section 2).
 *
 * A capsule is hub's crypto interior behind one contract. `enclave-aes` is the
 * default and ships INSIDE hub, so `npm install @noy-db/hub` alone is a working
 * noy-db. An alternative binds at BUILD TIME through hub's `imports` map —
 * deliberately not at runtime: a `createNoydb({ capsule })` option would be a
 * hot-swap surface, and a build condition lives in build config where the
 * shipped bundle stays auditable (`npm ls` tells an auditor whether a build is
 * plaintext-at-rest).
 *
 * ⛔ `CapsuleKey` is OPAQUE outside `capsule/`. Never construct, inspect or
 * serialise one; only pass it between contract functions. A fork may define it
 * as something that is not a `CryptoKey` at all — hardware-backed,
 * post-quantum, or null for a capsule that does no encryption.
 */
import { NoydbError } from '../kernel/errors.js'

/** Opaque key at the capsule seam. `CryptoKey` in the reference capsule. */
export type CapsuleKey = CryptoKey

/** Opaque asymmetric pair at the capsule seam. */
export type CapsuleKeyPair = CryptoKeyPair

/**
 * The groups a capsule may support. A capsule declares its set via
 * `capabilities()`; a service needing a group asserts at `createNoydb()`.
 *
 * `authenticate` and `seal` are what an `enclave-*` MUST support and an
 * `exclave-*` MUST refuse. That prefix rule is asserted by the conformance
 * suite from the package name, which is what makes the prefix a trust posture
 * rather than a naming convention.
 */
export type CapsuleGroup =
  | 'authenticate'
  | 'seal'
  | 'cipher'
  | 'digest'
  | 'sign'
  | 'codec'
  | 'sealing'
  | 'deterministic'
  | 'classify'

/**
 * Thrown at `createNoydb()` when a service needs a group the bound capsule
 * does not support.
 *
 * ⚠️ Never thrown on first write, and never discovered by try/catch probing: a
 * consumer learns at startup or not at all. A capability discovered mid-write
 * is a half-built vault.
 */
export class CapsuleNotSupportedError extends NoydbError {
  constructor(readonly group: CapsuleGroup, readonly requirer: string) {
    super(
      'CAPSULE_NOT_SUPPORTED',
      `Capsule does not support the "${group}" group, which "${requirer}" requires. ` +
      `An exclave capsule refuses "authenticate" and "seal" by design — services ` +
      `that need them cannot be used with it. Check capabilities().`,
    )
    this.name = 'CapsuleNotSupportedError'
  }
}
