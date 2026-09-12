/**
 * The enclave's `sign` group must interoperate byte-for-byte with
 * `@noy-db/attestation`'s Ed25519 — a hub-less verifier holding only that
 * package verifies what hub signs, and hub verifies what it signs.
 */
import { describe, it, expect } from 'vitest'
import { generateSigningKeyPair, signBytes, verifyBytes } from '../src/capsule/enclave-aes/index.js'
import { ed25519Sign, ed25519Verify, generateDocSigningKeyPair, keyIdFor } from '@noy-db/attestation'
import { sha256Hex } from '../src/capsule/enclave-aes/index.js'
import { signRecord, verifyRecord, signedBytes } from '../src/with-pod/signature.js'
import { ENCLAVE_SCHEME } from '../src/with-audit/attestation/scheme.js'

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

describe('hub signs through the enclave', () => {
  it('pod signature convention: signed by the enclave, verified by a hub-less attestation verifier', async () => {
    const { publicKeyB64, privateKeyPkcs8B64 } = await generateSigningKeyPair()
    const payload = { kind: 'pod', name: 'x' }
    const sig = await signRecord(privateKeyPkcs8B64, payload)
    expect(await verifyRecord(publicKeyB64, sig, payload)).toBe(true)
    expect(await ed25519Verify(publicKeyB64, sig, signedBytes(payload))).toBe(true)
  })

  it('ENCLAVE_SCHEME is the enclave sign group', async () => {
    const { publicKeyB64, privateKeyPkcs8B64 } = await generateSigningKeyPair()
    const m = new Uint8Array([1])
    const sig = await ENCLAVE_SCHEME.sign(privateKeyPkcs8B64, m)
    expect(await ENCLAVE_SCHEME.verify(publicKeyB64, sig, m)).toBe(true)
    expect(await verifyBytes(publicKeyB64, sig, m)).toBe(true)
  })

  // signer.ts computes keyId in-tree so hub need not import attestation at
  // runtime. This pins that the in-tree computation is the same function.
  it('signer keyId equals attestation keyIdFor', async () => {
    const { publicKeyB64 } = await generateSigningKeyPair()
    expect((await sha256Hex(new TextEncoder().encode(publicKeyB64))).slice(0, 16))
      .toBe(await keyIdFor(publicKeyB64))
  })
})
