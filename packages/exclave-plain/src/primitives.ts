/**
 * `exclave-plain`'s cipher: there isn't one.
 *
 * ⛔⛔ READ THIS BEFORE USING THIS PACKAGE. An **exclave** is the deliberate
 * inverse of an enclave: data lives OUTSIDE the trust boundary, by design.
 * Installing this capsule moves the security boundary out of noy-db and into
 * your store's access control — IAM, a VPC, a database grant. noy-db stops
 * being zero-knowledge, and the rows are readable by anyone who can read the
 * table. That is the entire point (the motivating case is a DynamoDB table
 * whose rows other tools read and write), and it is also the whole risk.
 *
 * WHAT `_mac` IS, AND IS NOT — this is the part that is easy to over-claim.
 * Every body still carries an integrity stamp: a SHA-256 over the record's
 * AAD (collection, id, `_tier`, `_by`, version) and the body bytes. It means:
 *
 *   ✅ a row corrupted in transit or at rest fails to read
 *   ✅ a row written by another tool that does not know the format is
 *      identifiable as a FOREIGN write rather than silently trusted
 *   ✅ a row moved to another collection/id, re-tiered, or re-authored no
 *      longer matches its stamp
 *
 *   ⛔ it is NOT a defence against a malicious store. There is no secret in
 *      exclave mode — that is what "no unlock, IAM is the authority" means —
 *      so anyone who can WRITE a row can also compute a valid stamp for it.
 *      An attacker who controls the store can forge any row they like.
 *
 * With `enclave-aes` the equivalent property is real: the AAD is bound into
 * AES-GCM under a key the store has never seen, so a hostile store cannot
 * produce a body that opens. Here it is a checksum with a domain separator.
 * Anything stronger would need a key to manage, which is exactly the thing
 * this capsule exists to avoid. Ruled 2026-09-13: report detection, never
 * claim defence.
 */
import {
  sha256Hex,
  bufferToBase64,
  base64ToBuffer,
  CapsuleNotSupportedError,
  type CapsulePrimitives,
  type CapsuleKey,
  type CapsuleGroup,
} from '@noy-db/hub/capsule'

/**
 * Domain separator. Without it the stamp is a bare hash of concatenated
 * inputs, and a body that happens to equal another record's `aad‖body` would
 * verify under both.
 */
const MAC_DOMAIN = 'noydb.exclave.mac.v1'

/** The stamp over `(aad, body)`. Empty AAD is encoded distinctly from absent. */
async function stamp(body: string, aad: Uint8Array | undefined): Promise<string> {
  const aadPart = aad === undefined ? '-' : bufferToBase64(aad)
  return sha256Hex(new TextEncoder().encode(`${MAC_DOMAIN} ${aadPart} ${body}`))
}

/** A group this capsule does not implement, refused by name. */
export function refuse(group: CapsuleGroup): never {
  throw new CapsuleNotSupportedError(group, '@noy-db/exclave-plain')
}

/**
 * The one key this capsule ever produces.
 *
 * ⚠️ It is a real `CryptoKey` because `CapsuleKey` is one, NOT because it
 * protects anything — nothing here encrypts under it. It exists so the shared
 * plumbing's key-shaped parameters have something to carry, and so a caller
 * that logs or compares keys sees an opaque object rather than a secret-looking
 * string it might start trusting.
 */
let placeholder: CryptoKey | undefined
async function nullKey(): Promise<CapsuleKey> {
  placeholder ??= await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
  return placeholder
}

export const plainPrimitives: CapsulePrimitives = {
  // ─── cipher: identity, with the stamp in place of the IV ────────────
  //
  // `_iv` carries the stamp and `_data` carries the plaintext body. Reusing
  // the existing two fields rather than inventing a third keeps every header
  // reader — history, sync, vault-head, tombstones — working unchanged, which
  // is the property the seam design insists on ("the header is identical
  // across capsules").
  encrypt: async (plaintext, _key, aad) => ({
    iv: await stamp(plaintext, aad),
    data: plaintext,
  }),

  decrypt: async (iv, data, _key, aad) => {
    const expected = await stamp(data, aad)
    // Constant-time is pointless here (both sides are public), but a mismatch
    // must still refuse rather than return the body — otherwise the stamp
    // detects nothing at all.
    if (iv !== expected) {
      throw new Error(
        'exclave-plain: integrity stamp does not match. This row was written ' +
        'by another tool, corrupted, or moved between collections/ids.',
      )
    }
    return data
  },

  encryptBytesWithAAD: async (bytes, _key, aad) => {
    const body = bufferToBase64(bytes)
    return { iv: await stamp(body, aad), data: body }
  },

  decryptBytesWithAAD: async (iv, data, _key, aad) => {
    const expected = await stamp(data, aad)
    if (iv !== expected) {
      throw new Error('exclave-plain: integrity stamp does not match on a byte body.')
    }
    return base64ToBuffer(data)
  },

  // ─── seal: refused — there are no keys to wrap ──────────────────────
  generateDEK: nullKey,
  wrapCek: () => refuse('seal'),
  unwrapCek: () => refuse('seal'),

  // ─── deterministic: refused — equality search needs a key ───────────
  encryptDeterministic: () => refuse('deterministic'),
  deriveDeterministicKey: () => refuse('deterministic'),

  // ─── sealing: refused — per-field keys need a key ───────────────────
  deriveSealedFieldKey: () => refuse('sealing'),
  deriveSealedFieldKeyFromCek: () => refuse('sealing'),

  // ─── classify: refused ──────────────────────────────────────────────
  mintVdigSlot: () => refuse('classify'),
  mintBidxTag: () => refuse('classify'),
  openVdigPayload: () => refuse('classify'),
  sealVdigPayload: () => refuse('classify'),

  // ─── encoding: shared, identical to every capsule ───────────────────
  bufferToBase64,
}

export { stamp, MAC_DOMAIN, nullKey }
