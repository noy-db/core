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
/**
 * Refuse at CONSTRUCTION when a service needs a capsule group the bound
 * capsule lacks.
 *
 * ⛔ At startup or not at all. A capability discovered on first write is a
 * half-built vault: some records sealed, a service silently inert, and a
 * consumer who cannot tell a missing capability from a bug. `capabilities()`
 * is a set, so this is a membership test — never a try/catch probe against the
 * primitive itself, which would make "unsupported" and "broken" the same
 * observation.
 *
 * Lives on the CONTRACT, not in the kernel: it depends on nothing but the
 * declared set, and every capsule's consumers need the same assertion.
 *
 * ⚠️ Per-service wiring is deliberately NOT done yet. `enclave-aes` supports
 * every group, so every call site would be unreachable code behind an
 * untestable branch. It lands in Stage C with `exclave-plain`, which is the
 * first capsule that refuses anything. Until then this is exercised against a
 * stub set — see `__tests__/capsule-capabilities.test.ts`.
 */
export function assertCapsuleSupports(
  caps: ReadonlySet<CapsuleGroup>,
  group: CapsuleGroup,
  requirer: string,
): void {
  if (!caps.has(group)) throw new CapsuleNotSupportedError(group, requirer)
}

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

/**
 * The 13 cipher primitives the shared plumbing needs — the ENTIRE surface a
 * capsule must actually implement.
 *
 * ⭐ This is the measurement that shaped Stage C. `enclave-aes` is ~4,200
 * lines, but only ~1,200 of them touch `crypto.subtle`; the other ~3,000 are
 * envelope assembly, record-identity AAD, tombstones and the record codec —
 * plumbing that is IDENTICAL for every capsule because it encodes hub's
 * envelope format, not anyone's cipher. `makeCapsule()` binds that plumbing to
 * these primitives, so a second capsule writes ~400 lines instead of ~3,400
 * and the format lives in exactly one place.
 *
 * The alternative — copying the plumbing into each capsule — was rejected for
 * a specific reason: nothing would fail when the two copies drifted. A change
 * to the tombstone shape or the AAD would have to be made twice, and the
 * second miss surfaces as an envelope that one capsule writes and the other
 * cannot read.
 *
 * ⚠️ Every primitive here is `async` except `bufferToBase64`, including ones a
 * plaintext capsule answers instantly. That is deliberate: a capsule that
 * needs real asynchrony (hardware-backed keys, a remote KMS) must be
 * expressible without changing this type, and a synchronous implementation
 * loses nothing by returning a resolved promise.
 */
export interface CapsulePrimitives<K = CapsuleKey> {
  encrypt(plaintext: string, key: K, aad?: Uint8Array): Promise<{ iv: string; data: string }>
  decrypt(iv: string, data: string, key: K, aad?: Uint8Array): Promise<string>
  encryptBytesWithAAD(bytes: Uint8Array, key: K, aad: Uint8Array): Promise<{ iv: string; data: string }>
  decryptBytesWithAAD(iv: string, data: string, key: K, aad: Uint8Array): Promise<Uint8Array>
  /** Same plaintext + key + context ⇒ same ciphertext. Refused by a capsule without the group. */
  encryptDeterministic(plaintext: string, key: K, context: string): Promise<{ iv: string; data: string }>
  /** ⚠️ ONE argument. The AES capsule derives the CONTEXT into the IV, not the key
   *  (`encryptDeterministic` calls `deriveDeterministicIV(dek, context, plaintext)`),
   *  so a `(dek, context)` signature here would have been a plausible-looking lie
   *  that only the call sites caught. */
  deriveDeterministicKey(dek: K): Promise<K>
  deriveSealedFieldKey(dek: K, collectionName: string, field: string): Promise<K>
  deriveSealedFieldKeyFromCek(cek: K, collectionName: string, field: string): Promise<K>
  generateDEK(): Promise<K>
  wrapCek(cek: K, dek: K): Promise<string>
  unwrapCek(wrapped: string, dek: K): Promise<K>
  /** Accepts `ArrayBuffer` too — the AES capsule's callers pass raw `subtle` output. */
  bufferToBase64(buffer: ArrayBuffer | Uint8Array): string
}
