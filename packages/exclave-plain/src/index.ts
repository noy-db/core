/**
 * `@noy-db/exclave-plain` — the plaintext capsule.
 *
 * ⛔⛔ THIS CAPSULE TURNS OFF ENCRYPTION. Rows are stored as readable data.
 * noy-db stops being zero-knowledge and your store's access control becomes
 * the security boundary. See `primitives.ts` for exactly what the `_mac`
 * integrity stamp does and does not protect against — the short version is
 * that it detects foreign and accidental writes and does NOT defend against a
 * store that wants to lie to you.
 *
 * HOW IT BINDS. hub resolves `#capsule` through its `imports` map. Set the
 * `noy-db:exclave-plain` condition in your bundler (`resolve.conditions`) or
 * Node (`--conditions=noy-db:exclave-plain`) and hub loads this module instead
 * of `enclave-aes`. There is deliberately no runtime switch: the choice is
 * visible in build config and in `npm ls`, where an auditor can see it.
 *
 * WHAT IS ACTUALLY IMPLEMENTED HERE. Six functions. Everything else is either
 * shared with every capsule (hub's envelope plumbing and the digest group,
 * both re-exported from `@noy-db/hub/capsule`) or a typed refusal. That ratio
 * is the point of the seam: a capsule is a cipher, not a re-implementation of
 * the database.
 */
import { makeCapsule, type Capsule } from '@noy-db/hub/capsule'
import { plainPrimitives, refuse } from './primitives.js'

export { capabilities } from './capabilities.js'

// ─── hub's envelope plumbing, bound to this capsule ──────────────────
const capsule = makeCapsule(plainPrimitives)

// ⚠️ ANNOTATED through `Capsule`, not destructured bare. A plain
// `export const { … } = capsule` infers each type from hub's INTERNAL
// plumbing modules, which a consumer cannot name — TS2742, 'not portable'.
// Naming them through the exported `Capsule` type keeps the emitted .d.ts
// self-contained.
export const openEnvelopeJson: Capsule['openEnvelopeJson'] = capsule.openEnvelopeJson
export const writeEnvelopeBody: Capsule['writeEnvelopeBody'] = capsule.writeEnvelopeBody
export const verifyRecordIdentity: Capsule['verifyRecordIdentity'] = capsule.verifyRecordIdentity
export const resolveStableCek: Capsule['resolveStableCek'] = capsule.resolveStableCek
export const rewrapBodyToDek: Capsule['rewrapBodyToDek'] = capsule.rewrapBodyToDek
export const rewrapEnvelope: Capsule['rewrapEnvelope'] = capsule.rewrapEnvelope
export const applyRewrappedBody: Capsule['applyRewrappedBody'] = capsule.applyRewrappedBody
export const isRewrappedUnder: Capsule['isRewrappedUnder'] = capsule.isRewrappedUnder
export const rekeyEnvelopeToDek: Capsule['rekeyEnvelopeToDek'] = capsule.rekeyEnvelopeToDek
export const rekeyEnvelopeIfNeeded: Capsule['rekeyEnvelopeIfNeeded'] = capsule.rekeyEnvelopeIfNeeded
export const envelopeOpensUnderAny: Capsule['envelopeOpensUnderAny'] = capsule.envelopeOpensUnderAny
export const rekeyBlobSet: Capsule['rekeyBlobSet'] = capsule.rekeyBlobSet
export const RecordCodec: Capsule['RecordCodec'] = capsule.RecordCodec
export const makeReservedEnvelopes: Capsule['makeReservedEnvelopes'] = capsule.makeReservedEnvelopes
export const SEALED_CEK_NS: Capsule['SEALED_CEK_NS'] = capsule.SEALED_CEK_NS
export const sealRecordToHost: Capsule['sealRecordToHost'] = capsule.sealRecordToHost
export const revokeSealedRecord: Capsule['revokeSealedRecord'] = capsule.revokeSealedRecord
export const rotateRecordCek: Capsule['rotateRecordCek'] = capsule.rotateRecordCek
export const findByDet: Capsule['findByDet'] = capsule.findByDet
export const queryByDet: Capsule['queryByDet'] = capsule.queryByDet

// ─── shared with every capsule ───────────────────────────────────────
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
  buildRecordAad,
  recordAadFor,
  buildRecordEnvelope,
  buildSealedRecordEnvelope,
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
  generateSigningKeyPair,
  signBytes,
  verifyBytes,
  ctEqualTags,
  evaluateKofN,
} from '@noy-db/hub/capsule'

// ─── the cipher: identity plus an integrity stamp ────────────────────
export const encrypt = plainPrimitives.encrypt
export const decrypt = plainPrimitives.decrypt
export const encryptBytesWithAAD = plainPrimitives.encryptBytesWithAAD
export const decryptBytesWithAAD = plainPrimitives.decryptBytesWithAAD
export const generateDEK = plainPrimitives.generateDEK

/** No AAD to bind, so the stamp covers the body alone. */
export const encryptBytes = (bytes: Uint8Array): Promise<{ iv: string; data: string }> =>
  plainPrimitives.encryptBytesWithAAD(bytes, undefined as never, new Uint8Array(0))
export const decryptBytes = (iv: string, data: string): Promise<Uint8Array> =>
  plainPrimitives.decryptBytesWithAAD(iv, data, undefined as never, new Uint8Array(0))

// ─── refusals ────────────────────────────────────────────────────────
//
// Every name below exists because hub's capsule door names it. Each throws
// CapsuleNotSupportedError with its GROUP, so a service that needs one fails
// at createNoydb() with a sentence saying which capability is missing — not on
// first write, and never as a confusing decrypt failure.

// authenticate — there is no secret; unlock always succeeds.
export const deriveKey = (): never => refuse('authenticate')
export const deriveSecretKey = (): never => refuse('authenticate')
export const deriveEchoKey = (): never => refuse('authenticate')
export const mintCanary = (): never => refuse('authenticate')
export const checkCanary = (): never => refuse('authenticate')
export const issueChallenge = (): never => refuse('authenticate')
export const computeBrokerProof = (): never => refuse('authenticate')
export const deriveBrokerProofBits = (): never => refuse('authenticate')
export const deriveBrokerProofKey = (): never => refuse('authenticate')
export const verifyBrokerProof = (): never => refuse('authenticate')

// seal — null keys; nothing to wrap or hand to a host.
export const generateEphemeralKey = (): never => refuse('seal')
export const exportDekSet = (): never => refuse('seal')
export const importDekSet = (): never => refuse('seal')
export const wrapKey = (): never => refuse('seal')
export const unwrapKey = (): never => refuse('seal')
export const wrapCek = (): never => refuse('seal')
export const unwrapCek = (): never => refuse('seal')
export const importCek = (): never => refuse('seal')
export const importTransferKey = (): never => refuse('seal')
export const importWrappingKey = (): never => refuse('seal') // core#65
export const generateRecipientKeyPair = (): never => refuse('seal')
export const exportRecipientPublicKeySpki = (): never => refuse('seal')
export const importRecipientPublicKeySpki = (): never => refuse('seal')
export const recipientWrap = (): never => refuse('seal')
export const recipientUnwrap = (): never => refuse('seal')
export const exportRecipientPrivateKeyPkcs8 = (): never => refuse('seal') // core#96
export const importRecipientKeyPair = (): never => refuse('seal') // core#96

// deterministic — blind equality needs a key the store must not have.
export const encryptDeterministic = (): never => refuse('deterministic')
export const decryptDeterministic = (): never => refuse('deterministic')
export const deriveDeterministicKey = (): never => refuse('deterministic')

// sealing — per-field keys need a key.
export const deriveSealedFieldKey = (): never => refuse('sealing')
export const deriveSealedFieldKeyFromCek = (): never => refuse('sealing')

// classify — digest-only fields need a key ceremony.
export const mintBidxTag = (): never => refuse('classify')
export const computeBidxTarget = (): never => refuse('classify')
export const deriveClassifyIndexKey = (): never => refuse('classify')
export const deriveClassifyIndexSalt = (): never => refuse('classify')
export const deriveVdigSlotKey = (): never => refuse('classify')
export const pbkdf2VerifyDigest = (): never => refuse('classify')
