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
import type { VdigFieldPolicy } from '../kernel/types.js'

/** Opaque key at the capsule seam. `CryptoKey` in the reference capsule. */
export type CapsuleKey = CryptoKey

/** Opaque asymmetric pair at the capsule seam. */
export type CapsuleKeyPair = CryptoKeyPair

/**
 * The groups a capsule may support. A capsule declares its set via
 * `capabilities()`; a service needing a group asserts at `createNoydb()`.
 *
 * ⭐ `authenticate` AND `seal` ARE POSTURE GROUPS (family#156/#168). They say
 * whether a capsule holds secrets at all — `authenticate` is `deriveKey`
 * (secret → KEK) and `seal` is `wrapKey`/`unwrapKey` (KEK wraps DEK), the
 * keyring's unlock chain. {@link PRIMITIVE_GROUPS} tags no primitive with
 * either, so no field form and no service implies them: what implies them is
 * opening a vault with a secret. An `enclave-*` MUST support both and an
 * `exclave-*` MUST refuse both, and that rule is asserted by the conformance
 * suite FROM THE PACKAGE NAME — which is what makes the prefix a trust posture
 * rather than a naming convention, and why a primitive-completeness check names
 * these two as exempt instead of reporting a green it cannot earn.
 *
 * ⛔ THE SHIPPED EXCLAVE DECLARES FOUR AND REFUSES SIX, and the old wording
 * here named two. `exclave-plain`'s `capabilities()` is exactly `cipher`,
 * `digest`, `sign`, `codec` — so beyond the two posture groups it also refuses
 * `per-record-keys`, `deterministic`, `sealing` and `classify`. Reading "an
 * exclave refuses authenticate and seal" as the whole story is how a consumer
 * concludes a plaintext capsule can still seal a field.
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
  // ⭐ ADDED 2026-09-16 (core#42). `wrapCek` / `unwrapCek` are real primitives
  // a capsule may refuse independently, and the conformance kit has carried a
  // live refusal test for them under this name since it shipped — but no
  // member of this union covered them, so the refusal could not be NAMED.
  // Found when `EnclaveNotSupportedError` turned out to accept it while this
  // union did not: three vocabularies disagreed, and this one was the one
  // missing a group rather than the error inventing one.
  | 'per-record-keys'

/**
 * Which group each primitive belongs to — the tag table family#168 asked for,
 * so `capabilities()` cannot drift from the implementation.
 *
 * ⭐ `Record<keyof CapsulePrimitives, …>` IS THE MECHANISM, and the reason this
 * is a table rather than a comment. A new primitive added without a tag is a
 * COMPILE error here, and a tag for a primitive that no longer exists is a
 * compile error too. A hand-kept list of group members is the second copy that
 * drifts; three vocabularies disagreeing about `per-record-keys` (core#42) is
 * what that drift looks like when nothing checks it.
 *
 * ⚠️ FOUR GROUPS HAVE NO PRIMITIVES, and that is correct, not a gap:
 *
 *  - `authenticate` and `seal` are POSTURE groups. They say whether a capsule
 *    holds secrets at all, which is a property of the implementation's
 *    intent — enforced by the `enclave-`/`exclave-` package-name rule the
 *    conformance kit asserts, never by calling a function. A completeness
 *    check over primitives is VACUOUSLY true for them, so it must name them as
 *    exempt rather than report a green it cannot earn.
 *  - `digest` and `sign` are PLUMBING. `sha256Hex`, `generateSigningKeyPair`,
 *    `signBytes`, `verifyBytes` are shared verbatim by every capsule
 *    (`plumbing/digest.ts`, `plumbing/sign.ts`) and are deliberately not
 *    primitives — hashes are not secrets, and a capsule choosing its own hash
 *    buys nothing but an envelope another capsule cannot read.
 *
 * ⛔ `wrapCek`/`unwrapCek` are `per-record-keys`, NOT `seal`. Ruled 2026-10-12
 * after the two shipped artefacts were found disagreeing: `exclave-plain`
 * refused them as `'seal'` while this union's own `per-record-keys` member was
 * added by core#42 expressly for them, and the conformance kit has tested their
 * refusal under that name since it shipped. The exclave is being corrected.
 */
export const PRIMITIVE_GROUPS: Readonly<Record<keyof CapsulePrimitives, CapsuleGroup>> = {
  // ─── cipher: the capsule's actual encryption ────────────────────────
  encrypt: 'cipher',
  decrypt: 'cipher',
  encryptBytesWithAAD: 'cipher',
  decryptBytesWithAAD: 'cipher',
  generateDEK: 'cipher',
  // ─── codec: encoding, identical for every capsule ───────────────────
  bufferToBase64: 'codec',
  // ─── sealing: per-field key derivation ──────────────────────────────
  deriveSealedFieldKey: 'sealing',
  deriveSealedFieldKeyFromCek: 'sealing',
  // ─── deterministic: equality search needs a key ─────────────────────
  encryptDeterministic: 'deterministic',
  deriveDeterministicKey: 'deterministic',
  // ─── per-record keys: the CEK lifecycle ─────────────────────────────
  wrapCek: 'per-record-keys',
  unwrapCek: 'per-record-keys',
  // ─── classify: the verify/blind-index group ─────────────────────────
  mintVdigSlot: 'classify',
  mintBidxTag: 'classify',
  openVdigPayload: 'classify',
  sealVdigPayload: 'classify',
  pbkdf2VerifyDigest: 'classify',
  blindedEqual: 'classify',
}

/**
 * The groups `PRIMITIVE_GROUPS` cannot speak for, with the reason.
 *
 * Published because a completeness check MUST distinguish "this group has no
 * unimplemented primitive" from "this group has no primitive to check" — those
 * are the same green and different facts, and conflating them is how a capsule
 * declares `seal` while implementing nothing a check can name.
 */
export const GROUPS_WITHOUT_PRIMITIVES: Readonly<Partial<Record<CapsuleGroup, string>>> = {
  authenticate: 'posture group — asserted from the enclave-/exclave- package name, not from a primitive',
  seal: 'posture group — asserted from the enclave-/exclave- package name, not from a primitive',
  digest: 'plumbing — plumbing/digest.ts is shared verbatim; hashes are not secrets',
  sign: 'plumbing — plumbing/sign.ts is shared verbatim',
}

/**
 * The three primitives a capsule MODULE does not expose, so a check driven off
 * the module object reaches 15 of 18.
 *
 * ⚠️ Not a gap in the contract — these are codec-internal by design: the record
 * codec calls them, nothing outside `capsule/` does, and putting them on the
 * door would publish the `_vdig` payload format as a consumer-facing API. A
 * check that silently iterated 15 and reported "every primitive" would be
 * stating a conjunction it never evaluated, which is this repo's own
 * false-green shape.
 */
export const PRIMITIVES_NOT_ON_THE_DOOR = ['mintVdigSlot', 'openVdigPayload', 'sealVdigPayload'] as const

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
 * ⛔ At startup or not at all, and "startup" is TWO POINTS since family#156:
 * `createNoydb()` for an enabled SERVICE, and `vault.collection()` for a
 * declared FIELD. Both are needed — a `classifiedFields` declaration writes
 * `_vdig` with no `classifiedStrategy` at all, so a single check at
 * `createNoydb()` would leave every write-side requirement unenforced while
 * looking complete. See `kernel/capsule-requirements.ts`.
 *
 * A capability discovered on first write is a half-built vault: some records
 * sealed, a service silently inert, and a consumer who cannot tell a missing
 * capability from a bug. `capabilities()` is a set, so this is a membership
 * test — never a try/catch probe against the primitive itself, which would make
 * "unsupported" and "broken" the same observation.
 *
 * Lives on the CONTRACT, not in the kernel: it depends on nothing but the
 * declared set, and every capsule's consumers need the same assertion.
 *
 * ⚠️ WIRED SINCE family#156, and the reason it waited still shapes how it is
 * tested: `enclave-aes` supports every group, so NO integration path in this
 * repo can reach a refusal, and a test that opens a real vault proves nothing
 * about whether the assertion exists. So the requirement tables are pure
 * functions tested against stub sets
 * (`__tests__/capsule-requirements.test.ts`) and a separate file mocks
 * `capabilities()` down to the exclave's four groups to prove the call sites
 * actually call them (`__tests__/capsule-requirements-wiring.test.ts`). A
 * predicate with no wiring test is the family#172 defect by construction.
 */
export function assertCapsuleSupports(
  caps: ReadonlySet<CapsuleGroup>,
  group: CapsuleGroup,
  requirer: string,
): void {
  if (!caps.has(group)) throw new CapsuleNotSupportedError(group, requirer)
}

/**
 * ⭐ THE CANONICAL not-supported refusal, ruled 2026-10-12 (family#168). Hub
 * throws it, and every capsule throws it for a group it refuses.
 *
 * ⛔ `EnclaveNotSupportedError` (`kernel/errors.ts`, code `ENCLAVE_NOT_SUPPORTED`)
 * is DEPRECATED and removed at a later breaking cut. Two classes with two codes
 * shipped side by side: hub never threw the enclave one, `exclave-plain` threw
 * this one, and the conformance kit matched only the enclave code — so a capsule
 * refusing a group CORRECTLY was reported as not refusing at all. The kit now
 * accepts both codes so existing forks keep passing; new code throws this.
 */
export class CapsuleNotSupportedError extends NoydbError {
  constructor(readonly group: CapsuleGroup, readonly requirer: string) {
    super(
      'CAPSULE_NOT_SUPPORTED',
      `Capsule does not support the "${group}" group, which "${requirer}" requires. ` +
      `A capsule declares its groups at build time: "authenticate" and "seal" are the ` +
      `POSTURE groups an exclave refuses by design, and the shipped exclave also refuses ` +
      `"per-record-keys", "deterministic", "sealing" and "classify" — six in all, declaring ` +
      `only cipher/digest/sign/codec. Check capabilities(), and either drop what needs this ` +
      `group or bind a capsule that has it.`,
    )
    this.name = 'CapsuleNotSupportedError'
  }
}

/**
 * Re-exported at the capsule seam (family#156), because a capsule author binding
 * `@noy-db/hub/capsule` could not previously catch — or construct — the error
 * their own capsule is expected to THROW.
 *
 * ⛔ The asymmetry was the defect: `classify/vdig.ts` raises `TamperedError` on
 * any AAD or auth-tag mismatch, and `record-codec.ts` converts a subtle
 * `OperationError` into one, so it is part of the contract a capsule implements.
 * It shipped only on hub's ROOT barrel, so a capsule package — which must not
 * import hub's root, that being the whole point of a narrow seam — had to
 * either re-declare it (two classes, `instanceof` false across the door) or
 * throw something hub does not recognise.
 *
 * ⚠️ Only the base error belongs here. `KeyringTamperedError` is raised by the
 * keyring, which lives in the kernel on hub's side of the seam — a capsule never
 * throws it and does not need to name it.
 */
export { TamperedError } from '../kernel/errors.js'

/**
 * The cipher primitives the shared plumbing needs — the ENTIRE surface a
 * capsule must actually implement.
 *
 * ⛔ NO COUNT IS STATED HERE, deliberately. This docstring said "the 13 cipher
 * primitives" while the interface had 16 members, and family#168 added two
 * more; nothing fails when a number in prose goes stale. Count the members.
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
 * ⚠️ Declared with PROPERTY syntax (`encrypt: (…) => …`), never method
 * shorthand. Two reasons, both measured. TypeScript checks method shorthand
 * BIVARIANTLY, so a capsule whose `encrypt` took the wrong number of arguments
 * would satisfy a shorthand declaration and fail only at a call site — the
 * exact hole #16 fell through. And `@typescript-eslint/unbound-method` refuses
 * to let a shorthand method be destructured off the object, which is precisely
 * how the plumbing consumes these.
 *
 * ⚠️ Every primitive here is `async` except `bufferToBase64`, including ones a
 * plaintext capsule answers instantly. That is deliberate: a capsule that
 * needs real asynchrony (hardware-backed keys, a remote KMS) must be
 * expressible without changing this type, and a synchronous implementation
 * loses nothing by returning a resolved promise.
 */
export interface CapsulePrimitives<K = CapsuleKey> {
  encrypt: (plaintext: string, key: K, aad?: Uint8Array) => Promise<{ iv: string; data: string }>
  decrypt: (iv: string, data: string, key: K, aad?: Uint8Array) => Promise<string>
  encryptBytesWithAAD: (bytes: Uint8Array, key: K, aad: Uint8Array) => Promise<{ iv: string; data: string }>
  decryptBytesWithAAD: (iv: string, data: string, key: K, aad: Uint8Array) => Promise<Uint8Array>
  /** Same plaintext + key + context ⇒ same ciphertext. Refused by a capsule without the group. */
  encryptDeterministic: (plaintext: string, key: K, context: string) => Promise<{ iv: string; data: string }>
  /** ⚠️ ONE argument. The AES capsule derives the CONTEXT into the IV, not the key
   *  (`encryptDeterministic` calls `deriveDeterministicIV(dek, context, plaintext)`),
   *  so a `(dek, context)` signature here would have been a plausible-looking lie
   *  that only the call sites caught. */
  deriveDeterministicKey: (dek: K) => Promise<K>
  deriveSealedFieldKey: (dek: K, collectionName: string, field: string) => Promise<K>
  deriveSealedFieldKeyFromCek: (cek: K, collectionName: string, field: string) => Promise<K>
  generateDEK: () => Promise<K>
  wrapCek: (cek: K, dek: K) => Promise<string>
  unwrapCek: (wrapped: string, dek: K) => Promise<K>
  /** Accepts `ArrayBuffer` too — the AES capsule's callers pass raw `subtle` output. */
  bufferToBase64: (buffer: ArrayBuffer | Uint8Array) => string

  // ─── optional group: classify ──────────────────────────────────────
  //
  // The record codec reaches into exactly two cipher-bound classify functions
  // (plus `normalizeForVerify`, which is pure and lives in the plumbing). They
  // sit here rather than in a separate object because the codec calls them the
  // same way it calls `encrypt` — and a capsule that refuses the `classify`
  // group implements them as a throw, which is the refusal the group means.
  mintVdigSlot: (
    value: string,
    policy: VdigFieldPolicy,
    prevBlob: string | undefined,
    cek: K,
    collection: string,
    id: string,
    field: string,
  ) => Promise<string>
  mintBidxTag: (normalized: string, dek: K, collection: string, field: string) => Promise<string>
  /**
   * PBKDF2-SHA256 → a fixed 32-byte verify digest over a PRE-NORMALIZED
   * candidate. Promoted to a primitive by family#168.
   *
   * ⭐ It was already a door export and already implemented by both shipped
   * capsules (`enclave-aes` for real, `exclave-plain` as a `refuse('classify')`
   * throw) — but it was not a primitive, so the plumbing could not call it, so
   * the verify oracle that needs it had to live INSIDE the reference capsule
   * and be reached by a dynamic import past the barrel. The missing declaration
   * was the whole reason for `DYNAMIC_ENCLAVE_BYPASS`.
   *
   * ⚠️ `iterations` is a PARAMETER, not a constant read from the capsule: a
   * stored `_vdig` payload carries its own authenticated `iter`, and a verify
   * must digest at the value the payload declares or it cannot compare against
   * a record written before an iteration bump.
   */
  pbkdf2VerifyDigest: (value: string, salt: Uint8Array, iterations: number) => Promise<Uint8Array>
  /**
   * Blinded equality of two arbitrary-length byte strings — the ONE comparison
   * construction the classify engines use (capsule seam spec §3 rule 2).
   * Promoted by family#168 alongside `pbkdf2VerifyDigest`.
   *
   * ⛔ It is a CAPSULE primitive, not plumbing, although the comparison itself
   * is cipher-free: the reference construction reduces both comparands to
   * 32-byte tags under a fresh ephemeral HMAC key, which is WebCrypto, and
   * `capsule/plumbing/**` may not call `crypto.subtle` (Check 10b). A capsule
   * with no MAC of its own answers the whole `classify` group with a throw.
   *
   * ⚠️ The constant-time tag compare it ends in (`ctEqualTags`) IS plumbing and
   * stays shared — a capsule choosing the blinding must not also get to choose
   * whether the final compare is constant-time.
   */
  blindedEqual: (a: Uint8Array, b: Uint8Array) => Promise<boolean>
  /** The vdig payload is sealed under a capsule-derived slot key, so open/seal
   *  are the capsule's, not the plumbing's. `rotateRecordCek` needs both to
   *  carry a classified slot across a key rotation. */
  openVdigPayload: (blob: string, cek: K, collection: string, id: string, field: string) => Promise<VdigPayload>
  sealVdigPayload: (payload: VdigPayload, cek: K, collection: string, id: string, field: string) => Promise<string>
}

/** The classified verify-digest payload, at the seam because both the capsule
 *  and the plumbing name it. Structural, not the capsule's own type. */
export interface VdigDigestEntry {
  readonly salt: string
  readonly hash: string
}

/**
 * The family's verify-digest iteration count (600K) — the value a NEW `_vdig`
 * slot is written at, and the default cost of the verify engines' C4 timing pad.
 *
 * ⚠️ A STORED payload's `iter` wins over this constant everywhere. This is the
 * write-side default only; a record written before an iteration bump must still
 * verify, which is why {@link CapsulePrimitives.pbkdf2VerifyDigest} takes
 * `iterations` as an argument.
 *
 * ⭐ It lives on the SEAM, next to the payload type that declares `iter`, for a
 * mechanical reason found in family#168: the verify engines moved into
 * `capsule/plumbing/` and must stay behind a lazy `import()` (they carry a
 * PBKDF2 oracle no consumer should pay for), while the enclave's WRITE side
 * needs the same constant eagerly. Importing it from the engine module would
 * have made the engine eager and silently undone the laziness — and the only
 * trace would have been a bundle-baseline number.
 */
export const VDIG_ITERATIONS = 600_000

export interface VdigPayload {
  readonly v: 1
  readonly alg: 'PBKDF2-SHA256'
  readonly iter: number
  readonly cur: VdigDigestEntry & { readonly at: string }
  readonly ring?: readonly VdigDigestEntry[]
}


// ─── what an alternative capsule builds on ─────────────────────────
//
// `@noy-db/hub/capsule` is the subpath an out-of-tree capsule installs, so the
// shared halves have to be reachable from it: `makeCapsule()` binds hub's
// envelope plumbing to a cipher, and the `digest` group is identical for every
// capsule by design. Without these, an alternative capsule would have to
// re-implement ~3,400 lines it does not own — and drift from them silently.
export { makeCapsule } from './plumbing/index.js'
export type { Capsule, RecordCodec } from './plumbing/index.js'
export {
  sha256Hex,
  sha256Bytes,
  hmacSha256Hex,
  hmacSignHex,
  hkdfAesGcmKey,
  deriveBlobAddressKey,
  derivePresenceKey,
  derivePresenceTagKey,
  generateIV,
  generateSalt,
  generateRecoverySecret,
  bufferToBase64,
  base64ToBuffer,
  encodeEchoParts,
  KEY_BITS,
} from './plumbing/digest.js'
export type { EchoSecretParts } from './plumbing/digest.js'
export {
  buildRecordAad,
  recordAadFor,
  buildRecordEnvelope,
  buildTombstone,
  isTombstone,
  isTombstoneShape,
  buildDeleteMarker,
  isDeleteMarker,
  requireSealedBody,
  sealedBodyArgs,
  envelopeBodySize,
  hasPerRecordKey,
  envelopeBodyForHash,
  hasSealedBody,
  normalizeForVerify,
  parseSealedSlot,
} from './plumbing/index.js'
export type { RecordIdentity, RecordRef } from './plumbing/index.js'
export { buildSealedRecordEnvelope } from './plumbing/record-envelope.js'
export { generateSigningKeyPair, signBytes, verifyBytes } from './plumbing/sign.js'
export { ctEqualTags } from './plumbing/ct-equal.js'
export { evaluateKofN } from './plumbing/kofn.js'
