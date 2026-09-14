/**
 * #34 — `erasureCompleteness()`: the answer to the only question a caller of
 * `vault.forget()` actually has.
 *
 * ⛔ WHY IT EXISTS. `ForgetResult` has ELEVEN independent residue channels.
 * None of them throws, only two document that non-empty means erasure is
 * INCOMPLETE, and there was no way to ask. "Erasure succeeded" is not
 * `recordsShredded > 0` — it is all eleven empty — and the result's shape
 * actively suggests otherwise, because the counts read like a success report
 * and the residues read like diagnostics. A consumer building a subject-facing
 * "your data has been deleted" on the obvious field makes a false statement in
 * writing, and nothing in hub's surface tells them.
 *
 * ⭐ THE DESIGN IS DEFAULT-DENY, and that is the whole point. The accessor does
 * not enumerate the eleven names — it treats EVERY array-valued field as
 * residue unless explicitly exempted. So a twelfth channel added later joins
 * the completeness check by construction, and exempting a field requires a
 * deliberate edit with a visible diff. Enumerating names would have reproduced
 * the defect: a correct caller today silently becoming incorrect tomorrow.
 *
 * The last test here is the one that keeps that promise honest.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withForget, erasureCompleteness } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { BLOB_CHUNKS_COLLECTION } from '../src/with-shape/blobs/blob-set.js'
import { makeStore, bytes } from './_blob-issues-store.js'
import type { EncryptedEnvelope } from '../src/kernel/types.js'
import type { ForgetResult } from '../src/with-audit/forget/index.js'

const SECRET = 'issue-34-erasure-completeness'

/** A vault whose `invoices` collection is keyed by `buyerId`. */
async function setup(perRecordKeys: boolean) {
  const store = makeStore()
  const db = await createNoydb({
    store, user: 'a', secret: SECRET,
    blobsStrategy: withBlobs(), historyStrategy: withHistory(),
    forgetStrategy: withForget({ subjects: { invoices: 'buyerId' } }),
  })
  const vault = await db.openVault('V')
  const invoices = vault.collection<{ id: string; buyerId: string }>(
    'invoices', perRecordKeys ? { perRecordKeys: true } : {},
  )
  return { store, vault, invoices }
}

/** Same vault with the blob service OFF — the shape that yields real residue. */
async function setupNoBlobs() {
  const store = makeStore()
  const db = await createNoydb({
    store, user: 'a', secret: SECRET, historyStrategy: withHistory(),
    forgetStrategy: withForget({ subjects: { invoices: 'buyerId' } }),
  })
  const vault = await db.openVault('V')
  const invoices = vault.collection<{ id: string; buyerId: string }>('invoices')
  return { store, vault, invoices }
}

describe('#34 — erasureCompleteness()', () => {
  it('reports COMPLETE when every residue channel is empty', async () => {
    const { vault, invoices } = await setup(true)
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await invoices.blob('i-1').put('contract.pdf', bytes(20_000))

    const result = await vault.forget('buyer-1')
    const c = erasureCompleteness(result)

    expect(c.complete).toBe(true)
    expect(c.channels).toEqual([])
  })

  it('reports INCOMPLETE, and names the channel, when a blob slot cannot be shredded', async () => {
    // Residue produced the way `forget.test.ts` group 5 does: the blob service
    // is OFF, so a slot row left on a shredded record cannot be crypto-shredded
    // and is reported. Paired with the control above so "complete: false"
    // cannot be satisfied by an accessor that always says false.
    const { store, vault, invoices } = await setupNoBlobs()
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await store.put('V', '_blob_slots_invoices', 'i-1', {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: 'x', _data: 'y',
    } as EncryptedEnvelope)

    const result = await vault.forget('buyer-1')
    const c = erasureCompleteness(result)

    expect(result.recordsShredded).toBe(1) // the obvious field says success
    expect(c.complete).toBe(false)          // and the honest answer is no
    expect(c.channels).toContain('blobResidueCollections')
    expect(c.residue.blobResidueCollections).toContain('invoices')
  })

  it('agrees with a hand-written check over every documented channel', async () => {
    // The comparison a careful consumer would write by hand today. If these
    // ever disagree, the accessor is wrong — this is the oracle.
    const { store, vault, invoices } = await setupNoBlobs()
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await store.put('V', '_blob_slots_invoices', 'i-1', {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: 'x', _data: 'y',
    } as EncryptedEnvelope)
    const r = await vault.forget('buyer-1')

    const byHand =
      r.unmigratedRecords.length === 0 && r.blobResidueCollections.length === 0 &&
      r.indexResidue.length === 0 && r.sealedCekResidue.length === 0 &&
      r.sealedResidue.length === 0 && r.ledgerDeltaResidue.length === 0 &&
      r.derivedResidueFrozen.length === 0 && r.lookupReferencesResidue.length === 0 &&
      r.scopedPurgeResidue.length === 0 && r.derivedResidueUndecodable.length === 0 &&
      r.derivedResidueDeclined.length === 0 && r.blobResidueRecords.length === 0 &&
      r.blobResidueETags.length === 0

    expect(erasureCompleteness(r).complete).toBe(byHand)
  })

  it('⭐ DEFAULT-DENY: every array field on ForgetResult is classified — a new one fails HERE', async () => {
    // This is the test that makes the accessor unable to go stale. It is not
    // "more coverage": it is the mechanism. Add a twelfth residue channel and
    // it is picked up automatically; add a non-residue array and this fails,
    // forcing the exemption to be written down rather than assumed.
    //
    // ⭐ THIS ALREADY EARNED ITS PLACE. #28's `blobResidueRecords` was added in
    // the very next commit after this file landed: `erasureCompleteness()`
    // picked it up with no change at all, and THIS test went red until the new
    // channel was classified — which is exactly the split the design wants.
    const { vault, invoices } = await setup(true)
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    const r = await vault.forget('buyer-1') as unknown as Record<string, unknown>

    const arrayFields = Object.entries(r).filter(([, v]) => Array.isArray(v)).map(([k]) => k).sort()
    const RESIDUE = [
      'blobResidueCollections', 'blobResidueETags', 'blobResidueRecords', 'derivedResidueDeclined', 'derivedResidueFrozen',
      'derivedResidueUndecodable', 'indexResidue', 'ledgerDeltaResidue',
      'lookupReferencesResidue', 'scopedPurgeResidue', 'sealedCekResidue',
      'sealedResidue', 'unmigratedRecords',
    ]
    const EXEMPT = ['collections'] // not a failure channel: the collections touched
    expect(arrayFields).toEqual([...RESIDUE, ...EXEMPT].sort())
    expect(RESIDUE).toHaveLength(13)
  })

  it('the instrument would fail on a fabricated residue — the control', () => {
    // Without this, "complete: true" above could pass against an accessor that
    // never inspects anything.
    const fake = { collections: ['x'], indexResidue: ['invoices:i-1:natId'] } as unknown as ForgetResult
    const c = erasureCompleteness(fake)
    expect(c.complete).toBe(false)
    expect(c.channels).toEqual(['indexResidue'])
  })

  /**
   * #28 — the residue names the RECORD, not just the collection.
   *
   * ⛔ Why it matters: "some blobs in `invoices` did not shred" cannot be
   * reconciled against a later reclaim pass, and a specific erasure request
   * asks "was THIS subject's data reclaimed". The record id was in scope on the
   * line that recorded only the collection — `ref.id` is used one line earlier
   * to open the blob set.
   *
   * ⚠️ Both fields are asserted together, on purpose. `blobResidueCollections`
   * is published, so it must keep reporting exactly what it always did; this
   * pins that the new channel is ADDITIVE rather than a widening.
   */
  it('#28 — blobResidueRecords carries collection:id, and the published field is unchanged', async () => {
    const { store, vault, invoices } = await setupNoBlobs()
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-1' })
    for (const id of ['i-1', 'i-2']) {
      await store.put('V', '_blob_slots_invoices', id, {
        _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: 'x', _data: 'y',
      } as EncryptedEnvelope)
    }

    const r = await vault.forget('buyer-1')

    // The coarse field: unchanged, one entry however many records are affected.
    expect(r.blobResidueCollections).toEqual(['invoices'])
    // The new one: every affected record, which is what a proof needs.
    expect([...r.blobResidueRecords].sort()).toEqual(['invoices:i-1', 'invoices:i-2'])
  })

  it('#28 — a clean erasure reports NO blob residue in either channel — the control', async () => {
    // Without this, the assertions above would pass equally against a channel
    // that reported every record unconditionally.
    const { vault, invoices } = await setupNoBlobs()
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    const r = await vault.forget('buyer-1')
    expect(r.blobResidueCollections).toEqual([])
    expect(r.blobResidueRecords).toEqual([])
  })
})
