/**
 * The enclave's `sign` group — Ed25519 over WebCrypto, base64url encoded.
 *
 * Moved in from `@noy-db/attestation` (capsule seam spec, D5): signing is a
 * crypto primitive, and the one a post-quantum enclave swaps (Ed25519 →
 * ML-DSA). Attestation issue/revoke and the pod signature convention call
 * these; `@noy-db/attestation` keeps its own copy for hub-less verifiers,
 * and `__tests__/enclave-sign-group.test.ts` pins the two interoperable.
 *
 * Encoding is base64url without padding — the same bytes-to-string mapping
 * attestation uses, so a key or signature is one string in both places.
 */
import { bufferToBase64, base64ToBuffer } from './crypto.js'

const ALG = 'Ed25519'
const subtle = globalThis.crypto.subtle

function toB64url(bytes: Uint8Array): string {
  return bufferToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return base64ToBuffer(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
}

export async function generateSigningKeyPair(): Promise<{
  /** base64url raw (32 bytes) — non-secret, publishable */
  publicKeyB64: string
  /** base64url pkcs8 — secret, wrap before persisting */
  privateKeyPkcs8B64: string
}> {
  const kp = await subtle.generateKey(ALG, true, ['sign', 'verify'])
  const rawPub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey))
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey))
  return { publicKeyB64: toB64url(rawPub), privateKeyPkcs8B64: toB64url(pkcs8) }
}

export async function signBytes(privateKeyPkcs8B64: string, message: Uint8Array): Promise<string> {
  const key = await subtle.importKey('pkcs8', fromB64url(privateKeyPkcs8B64) as BufferSource, ALG, false, ['sign'])
  return toB64url(new Uint8Array(await subtle.sign(ALG, key, message as BufferSource)))
}

/** Fails closed: any malformed input is `false`, never a throw. */
export async function verifyBytes(publicKeyB64: string, sigB64url: string, message: Uint8Array): Promise<boolean> {
  try {
    const key = await subtle.importKey('raw', fromB64url(publicKeyB64) as BufferSource, ALG, false, ['verify'])
    return await subtle.verify(ALG, key, fromB64url(sigB64url) as BufferSource, message as BufferSource)
  } catch {
    return false
  }
}
