/**
 * #28, second half — a deferred erasure set can be RECONCILED against the
 * reclaim pass that finished it.
 *
 * ⛔ THE GAP THIS CLOSES. `forget()` reported "some blobs did not shred" and
 * `compact({ reclaimLegacyBlobs })` reported "I reclaimed N blobs". Neither end
 * carried an identifier, so the two could not be matched: a caller could not
 * answer "was the thing MY erasure deferred actually reclaimed", which is the
 * only question a specific erasure request asks. Both ends already held the
 * eTag and discarded it.
 *
 * ⭐ THE IDENTIFIER IS THE ETAG, and only the eTag half of the residue. Blob
 * residue came in two flavours sharing one list — a bare eTag (the CONTENT
 * survived) and `collection:id:slot` (the slot row was undecodable). Only the
 * first joins to the sweep, which walks `_blob_index` by eTag. They are split
 * now; see `BlobSet.shredAllForRecord`.
 *
 * ⛔ IN-MEMORY ONLY, RULED 2026-09-14. An eTag is a content hash, so a
 * PERSISTED receipt listing them would let anyone with a candidate file confirm
 * the vault once held it — a re-identification oracle produced by the artefact
 * whose purpose is proving the data is gone. The reconciliation happens in the
 * caller's memory; `ledgerEntry` keeps recording counts, never values. The last
 * test pins that, because it is the property most likely to be "improved" away
 * by someone adding a helpful audit trail.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withForget, erasureCompleteness } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { BLOB_CHUNKS_COLLECTION } from '../src/with-shape/blobs/blob-set.js'
import { makeStore, bytes } from './_blob-issues-store.js'

const SECRET = 'issue-28-reclaim-reconcile'

/** A legacy (shared-DEK) blob-owning collection that is NOT a forget subject. */
async function vaultWithLegacyBlob() {
  const store = makeStore()
  const db = await createNoydb({
    store, user: 'a', secret: SECRET,
    blobsStrategy: withBlobs(), historyStrategy: withHistory(),
    forgetStrategy: withForget({ subjects: { invoices: 'buyerId' } }),
  })
  const vault = await db.openVault('V')
  const docs = vault.collection<{ id: string }>('docs')
  await docs.put('d1', { id: 'd1' })
  await docs.blob('d1').put('img', bytes(300_000))
  return { store, vault, docs }
}

describe('#28 — reconciling a deferred set against the reclaim', () => {
  it('compact() names the eTags it reclaimed, not just how many', async () => {
    const { store, vault, docs } = await vaultWithLegacyBlob()
    expect((await store.list('V', BLOB_CHUNKS_COLLECTION)).length).toBeGreaterThan(0)
    await docs.delete('d1') // legacy: slot released, chunks deferred

    const r = await vault.compact({ reclaimLegacyBlobs: true })

    expect(r.unreferencedLegacyBlobs.reclaimed).toBeGreaterThan(0)
    expect(r.unreferencedLegacyBlobs.reclaimedETags).toHaveLength(r.unreferencedLegacyBlobs.reclaimed)
    expect(await store.list('V', BLOB_CHUNKS_COLLECTION)).toEqual([])
  })

  it('a dryRun counts but names nothing — it deleted nothing', async () => {
    // Paired with the case above so "reclaimedETags is populated" cannot be
    // satisfied by a field that simply echoes every candidate blob.
    const { vault, docs } = await vaultWithLegacyBlob()
    await docs.delete('d1')

    const r = await vault.compact({ reclaimLegacyBlobs: true, dryRun: true })

    expect(r.unreferencedLegacyBlobs.blobs).toBeGreaterThan(0)
    expect(r.unreferencedLegacyBlobs.reclaimedETags).toEqual([])
    expect(r.unreferencedLegacyBlobs.reclaimed).toBe(0)
  })

  it('a clean vault reclaims nothing and names nothing — the control', async () => {
    const { vault } = await vaultWithLegacyBlob()
    // No delete: the blob is still referenced, so there is nothing to reclaim.
    const r = await vault.compact({ reclaimLegacyBlobs: true })
    expect(r.unreferencedLegacyBlobs.reclaimedETags).toEqual([])
  })

  it('⭐ the ledger entry still records COUNTS, never eTags — the oracle stays shut', async () => {
    // The property the whole design rests on. An eTag is a content hash; a
    // persisted receipt of them would let a holder of a candidate file confirm
    // the vault once held it. If someone "improves" the ledger by recording
    // residue VALUES, this fails.
    const store = makeStore()
    const db = await createNoydb({
      store, user: 'a', secret: SECRET,
      blobsStrategy: withBlobs(), historyStrategy: withHistory(),
      forgetStrategy: withForget({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('V')
    const invoices = vault.collection<{ id: string; buyerId: string }>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await invoices.blob('i-1').put('scan', bytes(50_000))

    const result = await vault.forget('buyer-1')
    const serialised = JSON.stringify(result.ledgerEntry)

    for (const eTag of [...result.blobResidueETags, ...result.blobResidueRecords]) {
      expect(serialised).not.toContain(eTag)
    }
    // And the completeness verdict is still derivable without them.
    expect(typeof erasureCompleteness(result).complete).toBe('boolean')
  })

  /**
   * ⭐ WHAT `blobResidueETags` ACTUALLY MEANS — measured, after the first
   * version of this test asserted the opposite and failed.
   *
   * ⛔ The intuitive reading is wrong: residue does NOT mean "the bytes are
   * still in the live store, waiting for a reclaim pass". `releaseRef` returns
   * `erasable ? 'shredded' : 'residue'`, so a LEGACY blob reports residue
   * unconditionally — and `forget()` passes `reclaimLegacy: true`, so it
   * deletes the chunks and the index row anyway. Residue means the bytes were
   * DELETED rather than made unreadable: no per-blob key existed to destroy, so
   * a backup taken before the erasure stays decryptable under the retained
   * collection DEK.
   *
   * ⚠️ Therefore `blobResidueETags` CANNOT be intersected with
   * `compact({ reclaimLegacyBlobs }).reclaimedETags` — the sweep reclaims
   * refCount-0 legacy index rows that still exist, and these no longer do. The
   * two sets are disjoint by construction. That reconciliation belongs to the
   * ordinary `collection.delete()` path, which passes `reclaimLegacy: false`
   * and genuinely defers (see the first test in this file).
   *
   * This test exists because a JSDoc example telling consumers to compute that
   * intersection was written, and would have had every caller conclude "nothing
   * was ever reclaimed" from an empty-by-construction result.
   */
  it('forget() on a legacy blob DELETES the chunks and still reports residue', async () => {
    const store = makeStore()
    // Session 1: no forget cascade, so the blob is written legacy (no _cek).
    const db1 = await createNoydb({ store, user: 'a', secret: SECRET, blobsStrategy: withBlobs() })
    const v1 = await db1.openVault('V')
    const c1 = v1.collection<{ id: string; sub: string }>('docs')
    await c1.put('d-1', { id: 'd-1', sub: 'subj-1' })
    await c1.blob('d-1').put('f.bin', bytes(120_000))
    expect((await store.list('V', BLOB_CHUNKS_COLLECTION)).length).toBeGreaterThan(0)
    db1.close()

    // Session 2: adopt the cascade over that existing data, WITHOUT migrating.
    const db2 = await createNoydb({
      store, user: 'a', secret: SECRET, blobsStrategy: withBlobs(),
      historyStrategy: withHistory(), forgetStrategy: withForget({ subjects: { docs: 'sub' } }),
    })
    const v2 = await db2.openVault('V')
    v2.collection<{ id: string; sub: string }>('docs')
    await v2.rebuildSubjectIndex()

    const erasure = await v2.forget('subj-1')

    // It could not crypto-shred, and says so — honestly incomplete.
    expect(erasure.blobResidueETags.length).toBeGreaterThan(0)
    expect(erasure.blobsShredded).toBe(0)
    expect(erasureCompleteness(erasure).complete).toBe(false)

    // ...but the live store IS clean. This is the half that surprises.
    expect(await store.list('V', BLOB_CHUNKS_COLLECTION)).toEqual([])

    // And so the sweep has nothing to reclaim — the intersection is empty
    // because both sets are, not because anything was reconciled.
    const swept = await v2.compact({ reclaimLegacyBlobs: true })
    expect(swept.unreferencedLegacyBlobs.reclaimedETags).toEqual([])
  })
})
