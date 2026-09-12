/**
 * THE DOOR. This is the ONLY hub file that may import the bound capsule.
 * Everything else in hub imports THIS file.
 *
 * Enforced by `capsule-door-only` in `scripts/check-architecture.mjs`, which
 * fails any other file naming `#capsule`. A door nothing enforces is not a
 * door — the enclave barrel it replaces was reached around 38 times before a
 * check existed.
 *
 * `#capsule` resolves through hub's `imports` map: `capsule/enclave-aes/` by
 * default, or an alternative package when a consumer sets a build condition.
 *
 * ⛔ THE RE-EXPORTS BELOW ARE EXPLICIT, AND MUST STAY THAT WAY.
 * `export * from '#capsule'` is the obvious spelling and it does not build:
 * `#capsule` is EXTERNAL (it has to be, or the capsule choice bakes in at hub's
 * build time), and esbuild cannot enumerate an external module's exports. Every
 * named import through the door then fails with "No matching export". Measured
 * 2026-09-12.
 *
 * Generated from `__tests__/enclave-surface.golden.json` — the same artefact
 * the surface test freezes, so the door and the golden cannot drift. Adding a
 * capsule primitive means adding it to the golden and regenerating.
 */
export {
  RecordCodec,
  SEALED_CEK_NS,
  applyRewrappedBody,
  base64ToBuffer,
  bufferToBase64,
  buildDeleteMarker,
  buildRecordAad,
  buildRecordEnvelope,
  buildSealedRecordEnvelope,
  buildTombstone,
  capabilities,
  checkCanary,
  computeBidxTarget,
  computeBrokerProof,
  ctEqualTags,
  decrypt,
  decryptBytes,
  decryptBytesWithAAD,
  decryptDeterministic,
  deriveBlobAddressKey,
  deriveBrokerProofBits,
  deriveBrokerProofKey,
  deriveClassifyIndexKey,
  deriveClassifyIndexSalt,
  deriveDeterministicKey,
  deriveEchoKey,
  deriveKey,
  derivePresenceKey,
  derivePresenceTagKey,
  deriveSealedFieldKey,
  deriveSealedFieldKeyFromCek,
  deriveSecretKey,
  deriveVdigSlotKey,
  encodeEchoParts,
  encrypt,
  encryptBytes,
  encryptBytesWithAAD,
  encryptDeterministic,
  envelopeBodyForHash,
  envelopeBodySize,
  envelopeOpensUnderAny,
  evaluateKofN,
  exportDekSet,
  exportRecipientPublicKeySpki,
  findByDet,
  generateDEK,
  generateEphemeralKey,
  generateIV,
  generateRecipientKeyPair,
  generateRecoverySecret,
  generateSalt,
  generateSigningKeyPair,
  hasPerRecordKey,
  hasSealedBody,
  hkdfAesGcmKey,
  hmacSha256Hex,
  hmacSignHex,
  importCek,
  importDekSet,
  importRecipientPublicKeySpki,
  importTransferKey,
  isDeleteMarker,
  isRewrappedUnder,
  isTombstone,
  isTombstoneShape,
  issueChallenge,
  makeReservedEnvelopes,
  mintBidxTag,
  mintCanary,
  openEnvelopeJson,
  pbkdf2VerifyDigest,
  queryByDet,
  recipientUnwrap,
  recipientWrap,
  recordAadFor,
  rekeyBlobSet,
  rekeyEnvelopeIfNeeded,
  rekeyEnvelopeToDek,
  resolveStableCek,
  revokeSealedRecord,
  rewrapBodyToDek,
  rewrapEnvelope,
  rotateRecordCek,
  sealRecordToHost,
  sha256Bytes,
  sha256Hex,
  signBytes,
  unwrapCek,
  unwrapKey,
  verifyBrokerProof,
  verifyBytes,
  verifyRecordIdentity,
  wrapCek,
  wrapKey,
  writeEnvelopeBody,
} from '#capsule'

export type {
  BrokerProofCanonicalParts,
  DeterministicContext,
  EchoSecretParts,
  EnclaveKey,
  EnclaveKeyPair,
  EncryptResult,
  IssuedChallenge,
  RecordEnvelopeBody,
  RecordIdentity,
  RecordRef,
  RewrappedBody,
  SealedShredSlot,
  SealingContext,
  SecretKeyUsage,
  VerifyBrokerProofArgs,
} from '#capsule'

export type { CapsuleKey, CapsuleKeyPair, CapsuleGroup } from './contract.js'
export { CapsuleNotSupportedError } from './contract.js'
