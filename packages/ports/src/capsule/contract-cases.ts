/**
 * @noy-db/ports/capsule — the contract suite every capsule passes.
 *
 * A capsule is noy-db's crypto interior behind one seam. `enclave-aes` ships
 * inside hub; `exclave-plain` and `enclave-pqc` are separate packages bound at
 * build time. This suite is what makes "implements the capsule contract" a
 * checkable claim rather than an assertion in a README.
 *
 * ⛔ EVERY NEGATIVE CASE IS PRECEDED BY ITS POSITIVE. A capsule whose `decrypt`
 * always threw would pass every tamper assertion vacuously, and a conformance
 * suite that can be satisfied by a broken implementation is worse than none —
 * it launders breakage as compliance. Same discipline as hub's
 * `adversarial-store-identity.test.ts`, which proves the untampered record
 * reads back before asserting any tamper is refused.
 */
import { describe, it, expect } from 'vitest'

/** The groups a capsule may declare. Mirrors `@noy-db/hub/capsule`. */
export type CapsuleGroup =
  | 'authenticate' | 'seal' | 'cipher' | 'digest'
  | 'sign' | 'codec' | 'sealing' | 'deterministic' | 'classify'

/**
 * The slice of a capsule this suite exercises. Structural rather than an
 * import of hub's type, so a capsule package can be tested without depending
 * on the exact hub version that declared it.
 */
export interface CapsuleUnderTest {
  capabilities(): ReadonlySet<CapsuleGroup>
  generateSalt(): Uint8Array
  deriveKey(secret: string, salt: Uint8Array): Promise<unknown>
  generateDEK(): Promise<unknown>
  encrypt(plaintext: string, dek: never, aad?: Uint8Array): Promise<{ iv: string; data: string }>
  decrypt(iv: string, data: string, dek: never, aad?: Uint8Array): Promise<string>
  wrapKey(dek: never, kek: never): Promise<string>
  unwrapKey(wrapped: string, kek: never): Promise<unknown>
  sha256Hex(data: Uint8Array): Promise<string>
  generateSigningKeyPair(): Promise<{ publicKeyB64: string; privateKeyPkcs8B64: string }>
  signBytes(privateKeyPkcs8B64: string, message: Uint8Array): Promise<string>
  verifyBytes(publicKeyB64: string, sig: string, message: Uint8Array): Promise<boolean>
}

export interface ConformanceOptions {
  /**
   * The capsule's PACKAGE NAME. The prefix rule is asserted from it, which is
   * what makes `enclave-`/`exclave-` a trust posture rather than a naming
   * convention: an enclave must hold secrets, an exclave must refuse to.
   */
  readonly name: string
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export function runCapsuleConformance(
  capsule: CapsuleUnderTest,
  options: ConformanceOptions,
): void {
  const { name } = options
  const caps = capsule.capabilities()

  describe(`capsule conformance — ${name}`, () => {
    describe('the prefix is a claim, and it is checked', () => {
      it('an enclave-* supports authenticate and seal; an exclave-* refuses both', () => {
        const isEnclave = /(^|\/)enclave-/.test(name)
        const isExclave = /(^|\/)exclave-/.test(name)
        expect(
          isEnclave || isExclave,
          `capsule package name "${name}" must carry an enclave-/exclave- prefix: it is the trust posture, not decoration`,
        ).toBe(true)

        if (isEnclave) {
          expect(caps.has('authenticate')).toBe(true)
          expect(caps.has('seal')).toBe(true)
        } else {
          // An exclave stores plaintext by design: there is no secret to
          // authenticate and no key hierarchy to seal with. Declaring either
          // would be a claim it cannot honour.
          expect(caps.has('authenticate')).toBe(false)
          expect(caps.has('seal')).toBe(false)
        }
      })

      it('declares at least cipher, digest and codec — the groups every capsule needs', () => {
        for (const g of ['cipher', 'digest', 'codec'] as CapsuleGroup[]) {
          expect(caps.has(g), `every capsule must declare "${g}"`).toBe(true)
        }
      })

      it('refuses mutation of its declared set', () => {
        const mutable = caps as Set<CapsuleGroup>
        expect(() => mutable.add('classify')).toThrow()
      })
    })

    describe('cipher', () => {
      it('round-trips, and only then refuses a tampered body', async () => {
        const dek = (await capsule.generateDEK()) as never
        const { iv, data } = await capsule.encrypt('hello capsule', dek)

        // POSITIVE FIRST: without this, every assertion below passes for a
        // capsule whose decrypt always throws.
        expect(await capsule.decrypt(iv, data, dek)).toBe('hello capsule')

        const flipped = corruptBase64(data)
        await expect(capsule.decrypt(iv, flipped, dek)).rejects.toThrow()
      })

      it('binds AAD — the same body refuses to open under a different one', async () => {
        const dek = (await capsule.generateDEK()) as never
        const aad = utf8('collection=invoices;id=r1')
        const { iv, data } = await capsule.encrypt('bound', dek, aad)

        expect(await capsule.decrypt(iv, data, dek, aad)).toBe('bound')

        // ⛔ Integrity is NOT optional, including for a capsule that stores
        // plaintext: an exclave still MACs (header, aad, canonical body), or
        // record identity and collection binding stop meaning anything and
        // hub's adversarial-store suite passes vacuously.
        await expect(
          capsule.decrypt(iv, data, dek, utf8('collection=invoices;id=r2')),
        ).rejects.toThrow()
      })
    })

    describe('digest', () => {
      it('is stable for stable input and differs for different input', async () => {
        const a = await capsule.sha256Hex(utf8('abc'))
        const b = await capsule.sha256Hex(utf8('abc'))
        const c = await capsule.sha256Hex(utf8('abd'))
        expect(a).toBe(b)
        expect(a).not.toBe(c)
        expect(a).toMatch(/^[0-9a-f]{64}$/)
      })
    })

    describe('sign', () => {
      it('verifies its own signature, and only then rejects a tampered message', async () => {
        if (!caps.has('sign')) return
        const { publicKeyB64, privateKeyPkcs8B64 } = await capsule.generateSigningKeyPair()
        const msg = utf8('attestation payload')
        const sig = await capsule.signBytes(privateKeyPkcs8B64, msg)

        expect(await capsule.verifyBytes(publicKeyB64, sig, msg)).toBe(true)
        expect(await capsule.verifyBytes(publicKeyB64, sig, utf8('other payload'))).toBe(false)
      })

      it('fails closed on malformed input rather than throwing', async () => {
        if (!caps.has('sign')) return
        const msg = utf8('x')
        expect(await capsule.verifyBytes('not-a-key', 'not-a-sig', msg)).toBe(false)
      })
    })

    describe('authenticate + seal (enclave only)', () => {
      it('wraps a DEK under a derived KEK and unwraps it back', async () => {
        if (!caps.has('seal') || !caps.has('authenticate')) return
        const salt = capsule.generateSalt()
        const kek = (await capsule.deriveKey('correct horse battery staple', salt)) as never
        const dek = (await capsule.generateDEK()) as never

        const wrapped = await capsule.wrapKey(dek, kek)
        const unwrapped = (await capsule.unwrapKey(wrapped, kek)) as never

        // POSITIVE FIRST: the unwrapped key must actually WORK, not merely
        // exist. A capsule returning a fresh useless key would otherwise pass.
        const { iv, data } = await capsule.encrypt('sealed', unwrapped)
        expect(await capsule.decrypt(iv, data, unwrapped)).toBe('sealed')
      })

      it('refuses to unwrap under the wrong secret', async () => {
        if (!caps.has('seal') || !caps.has('authenticate')) return
        const salt = capsule.generateSalt()
        const kek = (await capsule.deriveKey('right secret', salt)) as never
        const wrong = (await capsule.deriveKey('wrong secret', salt)) as never
        const dek = (await capsule.generateDEK()) as never

        const wrapped = await capsule.wrapKey(dek, kek)
        expect(await capsule.unwrapKey(wrapped, kek)).toBeDefined()
        await expect(capsule.unwrapKey(wrapped, wrong)).rejects.toThrow()
      })
    })
  })
}

/**
 * Flip one byte of a base64 body. Returns valid base64 so the failure under
 * test is the AEAD tag, not a decoding error — otherwise the assertion passes
 * for the wrong reason and would keep passing if integrity were removed.
 */
function corruptBase64(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  bytes.set([bytes[0]! ^ 0xff], 0)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
