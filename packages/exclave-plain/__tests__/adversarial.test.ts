/**
 * Adversarial store, exclave mode — the #1041 property, re-measured where it
 * still holds and pinned where it does not.
 *
 * `packages/hub/__tests__/adversarial-store-identity.test.ts` proves that a
 * hostile store cannot relocate, re-tier or re-author an `enclave-aes`
 * envelope, because the record's identity is bound into the AEAD under a key
 * the store never sees. This file asks the same questions of the plaintext
 * capsule, THROUGH HUB'S OWN PLUMBING rather than against the primitives
 * directly — the distinct thing being tested is that `openEnvelopeJson`
 * recomputes the AAD from the address it fetched from and lets the capsule's
 * refusal propagate, instead of swallowing it.
 *
 * ⚠️ WHAT CHANGES IN EXCLAVE MODE. Detection survives; defence does not. Every
 * case below catches a store that MOVED or EDITED a row it did not author. No
 * case here stops a store that recomputes the stamp — it has everything it
 * needs to. That gap is asserted explicitly at the bottom rather than left for
 * a reader to discover, because a file named `adversarial` that quietly proved
 * less than its enclave counterpart would be read as equivalence.
 */
import { describe, it, expect } from 'vitest'
import { makeCapsule, buildRecordEnvelope } from '@noy-db/hub/capsule'
import { plainPrimitives } from '../src/primitives.js'

const capsule = makeCapsule(plainPrimitives)

/** Write a row the way hub does, at a given identity. */
async function writeRow(collection: string, id: string, json: string, extra: { tier?: number; by?: string } = {}) {
  // `version` is part of the bound identity (#1093) — hub refuses to seal
  // without one, because a body sealed against no version cannot be reopened.
  const identity = { collection, id, version: 1, ...extra }
  const body = await capsule.writeEnvelopeBody(identity, json, null as never)
  return buildRecordEnvelope(identity, {
    iv: body._iv as string,
    data: body._data as string,
  })
}

describe('a store that moves a row is caught', () => {
  it('refuses a row served from a different id', async () => {
    const env = await writeRow('invoices', 'inv-1', '{"total":42}')
    // The store answers a fetch for inv-2 with inv-1's bytes.
    await expect(capsule.openEnvelopeJson({ collection: 'invoices', id: 'inv-2' }, env, null as never))
      .rejects.toThrow(/integrity stamp does not match/)
  })

  it('refuses a row served from a different collection', async () => {
    const env = await writeRow('invoices', 'inv-1', '{"total":42}')
    await expect(capsule.openEnvelopeJson({ collection: 'audit', id: 'inv-1' }, env, null as never))
      .rejects.toThrow(/integrity stamp does not match/)
  })

  it('reads back correctly at its own address — so the cases above are not vacuous', async () => {
    const env = await writeRow('invoices', 'inv-1', '{"total":42}')
    await expect(capsule.openEnvelopeJson({ collection: 'invoices', id: 'inv-1' }, env, null as never))
      .resolves.toBe('{"total":42}')
  })
})

describe('a store that edits envelope metadata is caught', () => {
  it('refuses a re-tiered row', async () => {
    const env = await writeRow('invoices', 'inv-1', '{"total":42}', { tier: 0 })
    const retiered = { ...env, _tier: 3 }
    await expect(capsule.openEnvelopeJson({ collection: 'invoices', id: 'inv-1' }, retiered, null as never))
      .rejects.toThrow(/integrity stamp does not match/)
  })

  it('refuses a re-authored row', async () => {
    const env = await writeRow('invoices', 'inv-1', '{"total":42}', { by: 'alice' })
    const reauthored = { ...env, _by: 'mallory' }
    await expect(capsule.openEnvelopeJson({ collection: 'invoices', id: 'inv-1' }, reauthored, null as never))
      .rejects.toThrow(/integrity stamp does not match/)
  })

  it('refuses an edited body', async () => {
    const env = await writeRow('invoices', 'inv-1', '{"total":42}')
    const edited = { ...env, _data: '{"total":999999}' }
    await expect(capsule.openEnvelopeJson({ collection: 'invoices', id: 'inv-1' }, edited, null as never))
      .rejects.toThrow(/integrity stamp does not match/)
  })
})

describe('⛔ the case that does NOT hold in exclave mode', () => {
  it('a store that rewrites the row wholesale is NOT caught, and must not be claimed to be', async () => {
    // Mallory controls the store. She knows the address and the format, so she
    // writes a row of her own at that address with a correctly computed stamp.
    const forged = await writeRow('invoices', 'inv-1', '{"total":999999}')

    // It opens. With `enclave-aes` this is impossible — the AEAD is keyed — and
    // that difference IS the trust boundary this capsule moves.
    await expect(capsule.openEnvelopeJson({ collection: 'invoices', id: 'inv-1' }, forged, null as never))
      .resolves.toBe('{"total":999999}')
  })
})
