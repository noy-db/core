/**
 * **capsule/enclave-aes** — the hub's crypto interior, behind one door.
 *
 * This barrel is **the fork-swap contract**: a sister project that wants a
 * different crypto engine (a different KDF, a hardware-backed keystore, a
 * post-quantum wrap algorithm, …) replaces the entire `capsule/enclave-aes/`
 * folder wholesale and only has to honor the exports below. Nothing outside
 * `capsule/enclave-aes/**` may deep-import `crypto.js` or `record-keys/*` directly
 * — `scripts/check-architecture.mjs`'s `enclave-barrel-only` check enforces
 * that mechanically. Import sites inside `capsule/enclave-aes/**` keep their
 * existing relative imports; this door is for everyone else.
 *
 * The export list is the OBSERVED contract — exactly the symbols consumed
 * from outside this folder today — grouped by the module that defines them:
 *
 *   - key type       — `crypto.ts`: `EnclaveKey`, the opaque key type every
 *                       barrel-facing signature traffics in (`= CryptoKey` in
 *                       noy-db's reference enclave; a fork redefines it to its
 *                       own key representation — see the type's own doc for
 *                       the fork contract).
 *   - crypto ops     — `crypto.ts`: AES-256-GCM encrypt/decrypt (+ bytes, AAD,
 *                       deterministic variants), SHA-256 / HMAC-SHA-256 hashing.
 *   - key lifecycle  — `crypto.ts` + `record-keys/lifecycle.ts`: KEK/DEK
 *                       derivation, AES-KW wrap/unwrap, per-record CEK
 *                       wrap/unwrap/import + resolution/re-wrap, HKDF-derived
 *                       presence/sealed-field keys, base64 helpers.
 *   - record codec   — `record-keys/record-codec.ts`: the per-record
 *                       encode/decode engine.
 *   - sealing        — `record-keys/sealing.ts`: the sealed-record grantor
 *                       primitives (seal/revoke/rotate to an `at-*` host).
 *   - deterministic  — `record-keys/deterministic.ts`: blind-equality lookup
 *                       over deterministically-encrypted fields.
 *   - tombstone      — `record-keys/tombstone.ts`: the erased-record residue.
 *   - envelope body  — `record-keys/envelope-body.ts`: the C1 protected-body
 *                       access contract (`openEnvelopeJson`,
 *                       `writeEnvelopeBody`, `hasPerRecordKey`,
 *                       `hasSealedBody`, `envelopeBodyForHash`) — the
 *                       sanctioned door onto
 *                       `_iv`/`_data`/`_cek`/`_sealed` for everyone outside
 *                       this folder.
 *   - reserved envelopes — `plumbing/sealed-slots.ts`: `makeReservedEnvelopes`,
 *                       the whole-envelope encrypt/decrypt door scoped to a
 *                       declared collection-name prefix (e.g. `_dict_`) —
 *                       `kernel/vault.ts` binds it for `DictionaryHandle`
 *                       (#629 Task 4).
 *
 * Additive changes only — removing or renaming an export here is breaking
 * for any fork. Frozen by `__tests__/enclave-surface-golden.test.ts`.
 *
 * **Refusal contract:** the barrel above is frozen — every symbol must
 * exist in any fork — but the optional groups (sealing, deterministic,
 * per-record-key lifecycle) MAY throw `EnclaveNotSupportedError` instead
 * of implementing the reference behavior. The core groups (crypto ops,
 * record codec, tombstone) MUST NOT throw it — they are load-bearing for
 * every consumer regardless of which enclave is wired in. noy-db's own
 * enclave supports every group, so it never throws this error.
 */

import { aesCapsule } from './bound.js'

// ─── key type ──────────────────────────────────────────────────────
export type { EnclaveKey, EncryptResult } from './crypto.js'

// ─── crypto ops ────────────────────────────────────────────────────
export {
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
  encryptDeterministic,
  decryptDeterministic,
} from './crypto.js'

// ─── key lifecycle ─────────────────────────────────────────────────
export {
  deriveKey,
  deriveSecretKey,
  generateDEK,
  generateEphemeralKey,
  importTransferKey,
  exportDekSet,
  importDekSet,
  wrapKey,
  unwrapKey,
  mintCanary,
  checkCanary,
  deriveDeterministicKey,
  deriveSealedFieldKey,
  deriveSealedFieldKeyFromCek,
  wrapCek,
  unwrapCek,
  importCek,
  deriveEchoKey,
} from './crypto.js'
export type { SecretKeyUsage } from './crypto.js'
// ─── shared plumbing ───────────────────────────────────────────────
//
// Everything from here to the end of this block used to be twelve modules
// under `./record-keys/`. They now live once in `../plumbing/`, and this
// capsule is one of two callers of `makeCapsule()`.
//
// The split below is not cosmetic. The cipher-FREE half is re-exported
// straight from its module: it inspects envelope fields and derives hash
// input, so there is nothing to bind and every capsule gets the identical
// function. The cipher-BOUND half is destructured off `aesCapsule`, which is
// `makeCapsule(aesPrimitives)` — one binding for the whole capsule, so a value
// exported here and a value used inside `classify/**` are the SAME object.
export {
  buildRecordAad,
  recordAadFor,
  buildRecordEnvelope,
  isTombstone,
  isTombstoneShape,
  buildTombstone,
  isDeleteMarker,
  buildDeleteMarker,
  requireSealedBody,
  sealedBodyArgs,
  envelopeBodySize,
  hasPerRecordKey,
  envelopeBodyForHash,
  hasSealedBody,
} from '../plumbing/index.js'
// ─── digest group ──────────────────────────────────────────────────
// Shared, not AES-specific: the seam design marks `digest` "as today" for every
// capsule. Re-exported here so the barrel's surface is unchanged.
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
} from '../plumbing/digest.js'
export type { EchoSecretParts } from '../plumbing/digest.js'
export type { RecordIdentity, RecordRef } from '../plumbing/index.js'
import type { RecordCodecBase } from '../plumbing/record-codec.js'
/**
 * `RecordCodec` is a VALUE (the capsule-bound subclass, destructured below) and
 * a TYPE (the module-level generic base). A type ALIAS can coexist with a value
 * of the same name; a `export type { RecordCodec }` RE-EXPORT cannot, which is
 * what `TS2323: Cannot redeclare exported variable` was saying.
 */
export type RecordCodec<T = Record<string, unknown>> = RecordCodecBase<T>
export { buildSealedRecordEnvelope } from '../plumbing/record-envelope.js'
export type { RecordEnvelopeBody } from '../plumbing/record-envelope.js'
export type { RewrappedBody } from '../plumbing/lifecycle.js'
export type { SealedShredSlot } from '../plumbing/record-codec.js'
export type { SealingContext } from '../plumbing/sealing.js'
export type { DeterministicContext } from '../plumbing/deterministic.js'

export const {
  // envelope body
  openEnvelopeJson,
  writeEnvelopeBody,
  verifyRecordIdentity,
  // key lifecycle
  resolveStableCek,
  rewrapBodyToDek,
  rewrapEnvelope,
  applyRewrappedBody,
  isRewrappedUnder,
  // rekey
  rekeyEnvelopeToDek,
  rekeyEnvelopeIfNeeded,
  envelopeOpensUnderAny,
  rekeyBlobSet,
  // record codec
  RecordCodec,
  // sealed slots — ONLY `makeReservedEnvelopes` is part of the frozen surface.
  // The other seven are capsule-internal; destructuring the whole capsule here
  // leaked them and widened the golden by 8 names. A surface is a contract, so
  // the fix is to narrow the barrel, not to re-baseline the golden.
  makeReservedEnvelopes,
  // sealing
  SEALED_CEK_NS,
  sealRecordToHost,
  revokeSealedRecord,
  rotateRecordCek,
  // deterministic
  findByDet,
  queryByDet,
} = aesCapsule

// ─── reserved envelopes (ViaCryptoCtx.reservedEnvelopes capability) ──

// ─── classify (stage-2 verify oracle primitives) ────────────────────
// ADDITIVE per Enclave Contract v1. A fork must provide these four; the
// verify/matchGroup orchestration (classify/verify.ts) sits behind the
// with-shape dynamic-import seam and is not part of the fork contract.
export { deriveVdigSlotKey } from './classify/vdig.js'
export { pbkdf2VerifyDigest } from './classify/digest.js'
export { ctEqualTags } from '../plumbing/ct-equal.js'
export { evaluateKofN } from '../plumbing/kofn.js'

// ─── classify (slice-2b equatable blind index) ──────────────────────
// ADDITIVE per Enclave Contract v1. A fork must provide these four; the
// findByDigest orchestration (collection.ts) sits behind the with-shape
// dynamic-import seam and is not part of the fork contract.
export { deriveClassifyIndexKey, deriveClassifyIndexSalt, mintBidxTag } from './classify/bidx.js'
export { computeBidxTarget } from './classify/find.js'

// ─── broker (proof derivation + challenge/verify, #479 slice 2) ─────
// ADDITIVE per Enclave Contract v1. A fork must provide these five; the
// seed lifecycle + network/cache orchestration (with-party/broker/**) sits
// behind its own dynamic-import seam and is not part of the fork contract.
export {
  deriveBrokerProofBits,
  deriveBrokerProofKey,
  computeBrokerProof,
  issueChallenge,
  verifyBrokerProof,
} from './broker/proof.js'
export type { BrokerProofCanonicalParts, VerifyBrokerProofArgs, IssuedChallenge } from './broker/proof.js'

// ─── sign ─────────────────────────────────────────────────────────────
export { generateSigningKeyPair, signBytes, verifyBytes } from '../plumbing/sign.js'

// ─── recipient sealing ────────────────────────────────────────────────
export type { EnclaveKeyPair } from './crypto.js'
export {
  generateRecipientKeyPair,
  exportRecipientPublicKeySpki,
  importRecipientPublicKeySpki,
  recipientWrap,
  recipientUnwrap,
} from './crypto.js'

// ─── capabilities ─────────────────────────────────────────────────────
// What THIS capsule supports. Part of the contract every capsule implements,
// not an enclave-aes detail — an alternative declares its own, and a service
// asserts against it at createNoydb() rather than failing on first write.
export { capabilities } from './capabilities.js'
