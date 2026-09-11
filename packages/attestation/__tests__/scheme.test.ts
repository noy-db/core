import { describe, it, expect } from 'vitest'
import {
  ed25519Scheme, signPayloadCore, verifyAttestation, signRevocationList, verifyRevocationList,
  generateDocSigningKeyPair, encodeQr, computeFieldHashes, type SignatureScheme,
} from '../src/index.js'

describe('SignatureScheme injection', () => {
  const schema = { fields: [{ path: 'name', normalize: 'trim' as const }] }

  it('defaults to Ed25519 and accepts a custom scheme for sign + verify symmetrically', async () => {
    const kp = await generateDocSigningKeyPair()
    const calls: string[] = []
    const spy: SignatureScheme = {
      sign: (k, m) => { calls.push('sign'); return ed25519Scheme.sign(k, m) },
      verify: (p, s, m) => { calls.push('verify'); return ed25519Scheme.verify(p, s, m) },
    }
    const fieldHashes = await computeFieldHashes('c2FsdA', schema, { name: 'A' })
    const core = { v: 1 as const, docId: 'd1', salt: 'c2FsdA', keyId: kp.keyId, fieldHashes }
    const sig = await signPayloadCore(core, kp.privateKeyPkcs8B64, spy)
    const qr = encodeQr({ ...core, alg: 'ed25519', sig })
    const res = await verifyAttestation(
      { qr, claimedFields: { name: 'A' }, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } },
      spy,
    )
    expect(res.valid).toBe(true)
    expect(calls).toEqual(['sign', 'verify'])

    const list = await signRevocationList(['d1'], '2026-09-07T00:00:00Z', kp.keyId, kp.privateKeyPkcs8B64, spy)
    expect(await verifyRevocationList(list, kp.publicKeyB64, spy)).toBe(true)
    expect(await verifyRevocationList(list, kp.publicKeyB64)).toBe(true) // default scheme verifies the same bytes
  })

  it('a scheme that refuses makes the signature invalid, nothing else', async () => {
    const kp = await generateDocSigningKeyPair()
    const never: SignatureScheme = { sign: ed25519Scheme.sign, verify: async () => false }
    const fieldHashes = await computeFieldHashes('c2FsdA', schema, { name: 'A' })
    const core = { v: 1 as const, docId: 'd1', salt: 'c2FsdA', keyId: kp.keyId, fieldHashes }
    const sig = await signPayloadCore(core, kp.privateKeyPkcs8B64)
    const qr = encodeQr({ ...core, alg: 'ed25519', sig })
    const res = await verifyAttestation(
      { qr, claimedFields: { name: 'A' }, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } },
      never,
    )
    expect(res.signatureValid).toBe(false)
    expect(res.reason).toBe('signature invalid')
  })
})
