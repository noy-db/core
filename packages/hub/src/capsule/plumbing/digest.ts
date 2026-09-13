/**
 * The digest group — hashing, HKDF over public inputs, randomness, base64.
 *
 * Shared by every capsule, and that is the design's own answer rather than a
 * convenience: the capsule-seam spec's group table marks `digest` "as today"
 * for `enclave-aes`, `exclave-plain` AND `enclave-pqc` alike. Hashes are not
 * secrets, so there is nothing here to swap — a plaintext capsule computes the
 * same SHA-256 as an encrypting one, and a blob address derived differently
 * per capsule would simply be a bug.
 *
 * ⚠️ This module calls `crypto.subtle`, inside `capsule/**`, which is where the
 * `subtle-outside-capsule` ban permits it. The ban's TARGET is code outside the
 * capsule reaching for WebCrypto on its own; a shared capsule-layer primitive
 * is the thing it is pushing callers toward.
 */
import { ValidationError } from '../../kernel/errors.js'

const subtle = globalThis.crypto.subtle

/** AES key size in bits. Shared: every capsule that derives an AES-GCM subkey
 *  from the digest group produces a 256-bit key, or the derivations diverge. */
export const KEY_BITS = 256

const SALT_BYTES = 32
export const IV_BYTES = 12
const RECOVERY_SECRET_BYTES = 32
const PRESENCE_TAG_KEY_DOMAIN = 'noydb.presence.tag.v1'

/** The echo-secret typed parts. Encoding lives here with `encodeEchoParts`; the
 *  KEK derivation that consumes it stays in the capsule's `authenticate` group. */
export interface EchoSecretParts {
  readonly prompt: string
  readonly echo: string
  readonly key: string
}

const ECHO_KDF_CONTEXT = new Uint8Array([0xff, ...new TextEncoder().encode('noydb-echo-secret-v1')])

/**
 * AG-1 encoding: domain context + 4-byte big-endian length prefix per
 * part. Two independent guarantees make a single typed string unable to
 * derive an echo vault's KEK (spec AG-1):
 *
 *   1. The `0xFF` context prefix — UTF-8 never produces that byte, so the
 *      encoding is provably not the encoding of ANY string (not merely of
 *      no separator-joined form).
 *   2. Structural length prefixes — part boundaries are key material, so
 *      re-splitting the same characters changes the derived KEK.
 *
 * @throws ValidationError when any part is not a string — the single
 * chokepoint every echo KEK derivation and block mint passes through, so a
 * malformed parts object cannot be `TextEncoder`-coerced into key material.
 */
export function encodeEchoParts(parts: EchoSecretParts): Uint8Array {
  for (const name of ['prompt', 'echo', 'key'] as const) {
    if (typeof parts?.[name] !== 'string') {
      throw new ValidationError('echo secret parts must be three strings: prompt, echo, key')
    }
  }
  const enc = new TextEncoder()
  const segments = [parts.prompt, parts.echo, parts.key].map((p) => enc.encode(p))
  const total = ECHO_KDF_CONTEXT.length + segments.reduce((n, s) => n + 4 + s.length, 0)
  const out = new Uint8Array(total)
  out.set(ECHO_KDF_CONTEXT, 0)
  let offset = ECHO_KDF_CONTEXT.length
  for (const s of segments) {
    new DataView(out.buffer).setUint32(offset, s.length, false)
    out.set(s, offset + 4)
    offset += 4 + s.length
  }
  return out
}

/**
 * SHA-256 hex digest of raw bytes. Used to derive content-addressed
 * eTags for blob deduplication. Computed on plaintext bytes
 * before compression and encryption so the eTag identifies content, not
 * ciphertext, and survives re-encryption (key rotation, re-upload).
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await subtle.digest('SHA-256', data as unknown as BufferSource)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** SHA-256 of raw bytes, as bytes. */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', data as unknown as BufferSource))
}

// ─── HMAC-SHA-256 ─────────────────────────────

/**
 * Derive the blob CONTENT-ADDRESSING key for one tier (#1126).
 *
 * The blob eTag is an HMAC over the plaintext. It used to be keyed by the
 * `_blob` DEK — the very key `rotateKeys` replaces — so after any rotation
 * `HMAC(live DEK, plaintext) !== storedETag` for every blob written before it,
 * permanently. `decryptResponse()` checks that unconditionally, so the
 * presigned-URL read path raised `TamperedError` on legitimate data forever;
 * dedup also split, minting a second address for identical bytes.
 *
 * The fix is a `root` that rotation never touches (`_blob_addr`, refused by
 * `rotateKeys` exactly as `_roster` is). Rotation then re-keys chunk BODIES
 * while every address stays stable, which is what makes the AAD
 * `{eTag}:{i}:{count}` and every `_blob_index` / `_blob_slots_*` /
 * `_blob_versions_*` row survive it untouched.
 *
 * **Derived PER TIER, deliberately.** A single vault-wide address would make an
 * elevated blob and a tier-0 blob with identical content share an eTag,
 * leaking equality across a boundary the tier system exists to enforce — and
 * `rehomeForTier` re-addresses on a tier move precisely because the address is
 * tier-scoped today. Domain separation keeps that property while removing the
 * rotation coupling: the two are independent axes, and only one of them was
 * ever meant to change the address.
 *
 * Same HKDF idiom as `asKwKey`, with its own salt so the addressing key can
 * never coincide with a wrapping or encryption key.
 */
export async function deriveBlobAddressKey(root: CryptoKey, tier: number): Promise<CryptoKey> {
  const rawRoot = await subtle.exportKey('raw', root)
  const hkdfKey = await subtle.importKey('raw', rawRoot, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode('noydb-blob-address')
  const info = new TextEncoder().encode(`tier:${tier}`)
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, KEY_BITS)
  // Imported as AES-GCM only because `hmacSha256Hex` re-exports raw and
  // re-imports as HMAC; the algorithm tag here is a carrier, never used to
  // encrypt anything.
  return subtle.importKey('raw', bits, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

/**
 * HMAC-SHA-256(key, data) as hex.
 *
 * Keyed, unlike {@link sha256Hex}: blob eTags derived with this are opaque to
 * the store, so an attacker with store access cannot pre-compute the address of
 * a file they guess at. Dedup still works inside a vault, where the key is shared.
 */
export async function hmacSha256Hex(key: CryptoKey, data: Uint8Array): Promise<string> {
  // Export AES-GCM DEK raw bytes → import as HMAC key
  const rawKey = await subtle.exportKey('raw', key)
  const hmacKey = await subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await subtle.sign('HMAC', hmacKey, data as unknown as BufferSource)
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── AAD-aware Binary Encrypt / Decrypt ──

/**
 * Derive an AES-256-GCM presence key from a collection DEK using HKDF-SHA256.
 *
 * The presence key is domain-separated from the data DEK by the fixed salt
 * `'noydb-presence'` and the `info` = collection name. This means:
 *  - The adapter never sees the presence key.
 *  - Presence payloads rotate automatically when the collection DEK is rotated.
 *  - Revoked users cannot derive the new presence key after a DEK rotation.
 *
 * @param dek            The collection's AES-256-GCM DEK (extractable).
 * @param collectionName Used as the HKDF `info` parameter for domain separation.
 * @returns A non-extractable AES-256-GCM key suitable for presence payload encryption.
 */
export async function derivePresenceKey(dek: CryptoKey, collectionName: string): Promise<CryptoKey> {
  // Step 1: export DEK raw bytes
  const rawDek = await subtle.exportKey('raw', dek)

  // Step 2: import as HKDF key material
  const hkdfKey = await subtle.importKey(
    'raw',
    rawDek,
    'HKDF',
    false,
    ['deriveBits'],
  )

  // Step 3: derive 256 bits with salt='noydb-presence' and info=collectionName
  const salt = new TextEncoder().encode('noydb-presence')
  const info = new TextEncoder().encode(collectionName)
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    KEY_BITS,
  )

  // Step 4: import derived bits as AES-GCM key
  return subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Derive the presence-TAG key from a collection DEK: a non-extractable,
 * sign-only HMAC-SHA256 key, HKDF-separated from the presence PAYLOAD key
 * ({@link derivePresenceKey}) by its own salt. The tag is the adapter-opaque
 * record id for storage-polled presence; the adapter never sees the userId.
 */
export async function derivePresenceTagKey(dek: CryptoKey, collectionName: string): Promise<CryptoKey> {
  const rawDek = await subtle.exportKey('raw', dek)
  const hkdfKey = await subtle.importKey('raw', rawDek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode(PRESENCE_TAG_KEY_DOMAIN)
  const info = new TextEncoder().encode(collectionName)
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, KEY_BITS)
  return subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/**
 * HMAC-SHA256 hex with a key that IS an HMAC key (e.g. from
 * {@link derivePresenceTagKey}). {@link hmacSha256Hex} takes an AES-GCM
 * carrier and re-imports its raw bytes, which needs an extractable key;
 * this one signs directly and works with non-extractable keys.
 */
export async function hmacSignHex(key: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await subtle.sign('HMAC', key, data as unknown as BufferSource)
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * HKDF-SHA256 → non-extractable AES-256-GCM key from caller-supplied input
 * key material. The magic-link content key derives here from
 * `(serverSecret, SHA-256(token), info)`; `salt`/`info` are the caller's
 * domain separation, this function adds none.
 */
export async function hkdfAesGcmKey(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ─── Sealed Field Key Derivation ──────────────────────────

/** Generate a random 12-byte IV for AES-GCM. */
export function generateIV(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
}

/** Generate a random 32-byte salt for PBKDF2. */
export function generateSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES))
}

/**
 * Mint a fresh recovery secret — the high-entropy value a recovery profile
 * wraps the DEK set under and then hands out (Shamir splits it into shares;
 * paper prints it). Not a salt: a salt is public, this is not, and a fork
 * may size them differently. The reference enclave returns 32 bytes.
 *
 * Callers must zero the buffer once it has been wrapped and split.
 */
export function generateRecoverySecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(RECOVERY_SECRET_BYTES))
}

// ─── Recipient sealing (RSA-OAEP-SHA256) ───────────────────────────────
//
// The managed-secret TLV wraps a per-blob CEK for a recipient who holds an
// RSA private key — locally (`MemoryRecipientSealer`) or in a KMS
// (`@noy-db/at-aws-kms`, wire-compatible with RSAES_OAEP_SHA_256). Only the
// asymmetric steps live here; the TLV layout stays in `managed-secret.ts`.
export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}
export function base64ToBuffer(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
