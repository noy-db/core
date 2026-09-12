/**
 * `enclave-aes` as a {@link CapsulePrimitives} — the 13 functions the shared
 * plumbing binds to.
 *
 * ⭐ THE ASSIGNMENT BELOW IS A TEST, and it is the reason this file exists as
 * a file rather than an inline object at the `makeCapsule()` call. Declaring
 * the seam type and implementing it are two different acts; nothing checks a
 * hand-written interface against the module it claims to describe unless
 * something binds one to the other. This binding caught two errors in the
 * declaration within minutes of it being written:
 *
 *   - `deriveDeterministicKey` was declared `(dek, context)`. It takes ONE
 *     argument — the AES capsule derives the context into the IV, not the key.
 *   - `bufferToBase64` was declared `(bytes: Uint8Array)`. It also accepts an
 *     `ArrayBuffer`, which is what its callers actually pass.
 *
 * Both would have compiled here and failed at the far end of the refactor,
 * where the cause is no longer visible. (The same lesson as `#16`: a
 * structural declaration drifts silently from its implementation until an
 * assignment pins the two together.)
 *
 * ⚠️ Method shorthand in `CapsulePrimitives` is checked BIVARIANTLY, so this
 * assignment does NOT catch parameter-arity drift — that is exactly how the
 * `deriveDeterministicKey` mistake survived the type and was caught by a call
 * site instead. Keep the conformance kit's call-site coverage; this assignment
 * is necessary, not sufficient.
 */
import type { CapsulePrimitives } from '../contract.js'
import {
  encrypt,
  decrypt,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
  encryptDeterministic,
  deriveDeterministicKey,
  deriveSealedFieldKey,
  deriveSealedFieldKeyFromCek,
  generateDEK,
  wrapCek,
  unwrapCek,
  bufferToBase64,
} from './crypto.js'

export const aesPrimitives: CapsulePrimitives = {
  encrypt,
  decrypt,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
  encryptDeterministic,
  deriveDeterministicKey,
  deriveSealedFieldKey,
  deriveSealedFieldKeyFromCek,
  generateDEK,
  wrapCek,
  unwrapCek,
  bufferToBase64,
}
