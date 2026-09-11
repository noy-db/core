/**
 * The enclave's `sign` group must interoperate byte-for-byte with
 * `@noy-db/attestation`'s Ed25519 — a hub-less verifier holding only that
 * package verifies what hub signs, and hub verifies what it signs.
 */
import { describe, it, expect } from 'vitest'
import { generateSigningKeyPair, signBytes, verifyBytes } from '../src/kernel/enclave/index.js'
import { ed25519Sign, ed25519Verify, generateDocSigningKeyPair } from '@noy-db/attestation'

describe('enclave sign group ↔ @noy-db/attestation Ed25519', () => {
  const msg = new TextEncoder().encode('hello')

  it('attestation verifies what the enclave signs', async () => {
    const { publicKeyB64, privateKeyPkcs8B64 } = await generateSigningKeyPair()
    expect(publicKeyB64).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const sig = await signBytes(privateKeyPkcs8B64, msg)
    expect(await ed25519Verify(publicKeyB64, sig, msg)).toBe(true)
    expect(await verifyBytes(publicKeyB64, sig, msg)).toBe(true)
  })

  it('the enclave verifies what attestation signs, and fails closed on garbage', async () => {
    const kp = await generateDocSigningKeyPair()
    const sig = await ed25519Sign(kp.privateKeyPkcs8B64, msg)
    expect(await verifyBytes(kp.publicKeyB64, sig, msg)).toBe(true)
    expect(await verifyBytes(kp.publicKeyB64, sig, new TextEncoder().encode('other'))).toBe(false)
    expect(await verifyBytes('not-a-key', sig, msg)).toBe(false)
  })
})
