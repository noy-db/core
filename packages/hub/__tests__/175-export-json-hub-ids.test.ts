/**
 * family#175 — `exportVaultJSON` now carries each record's HUB ID, so an
 * exported vault can be diffed and re-imported by id.
 *
 * ## ⛔ What measuring it first turned up, which the row understated
 *
 * The row says an id-less record cannot be restored. Measured on main, the
 * situation was worse: `diffVault` could not read an `exportVaultJSON`
 * artefact AT ALL. The artefact nests records under
 * `collections: { <coll>: { records } }`, while the candidate parser required
 * the top-level value to BE the array (the `dump()`-like flat shape). So
 * `collections` was skipped, the candidate parsed as EMPTY, and diffing a
 * vault against ITS OWN export reported every record as DELETED — with
 * `skipped: 0`, so nothing signalled a problem:
 *
 *     { add: 0, modify: 0, delete: 2, total: 2, skipped: 0 }
 *
 * Applying that diff would have emptied the vault. Case 1 is that regression.
 *
 * ## The shape
 *
 * `ids` is POSITIONAL — `ids[i]` identifies `records[i]` — the same choice
 * family#166 made for `envelopeMeta`, and for the same reason: a record need
 * not carry an id FIELD at all, because hub's id is the store key rather than
 * a property of the record. Additive: an artefact without `ids` still diffs
 * by field, and a reader that does not know the key ignores it.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, diffVault } from '../src/index.js'

const SECRET = 'pw-175-export-hub-ids-long'
interface Row extends Record<string, unknown> { id?: string; n: number }

async function vault() {
  const db = await createNoydb({ store: memoryStore({ full: true }), user: 'owner', secret: SECRET, validateSecret: false })
  return { db, v: await db.openVault('acme') }
}

describe('family#175 — hub ids in the JSON export', () => {
  it('1. ⛔ THE REGRESSION: a vault diffed against its OWN export shows no change', async () => {
    const { db, v } = await vault()
    await v.collection<Row>('invoices').put('i1', { id: 'i1', n: 1 })
    await v.collection<Row>('invoices').put('i2', { id: 'i2', n: 2 })

    const d = await diffVault(v, await v.exportJSON())
    expect(d.summary, 'the export read as an empty candidate — every record looked deleted').toMatchObject({
      add: 0, modify: 0, delete: 0, total: 0, skipped: 0,
    })
    await db.close()
  })

  it('2. an ID-LESS record round-trips, keyed by its hub id', async () => {
    // The row's own case. The record carries no `id` field, so field-keying
    // cannot identify it on either side; the hub id can.
    const { db, v } = await vault()
    await v.collection<Row>('notes').put('k1', { n: 5 })
    await v.collection<Row>('notes').put('k2', { n: 6 })

    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Row[]; ids?: string[] }> }
    expect(parsed.collections.notes!.ids, 'the artefact carries no hub ids').toBeDefined()
    expect([...parsed.collections.notes!.ids!].sort()).toEqual(['k1', 'k2'])

    const d = await diffVault(v, json)
    expect(d.summary, 'an id-less record could not be matched across the two sides').toMatchObject({
      add: 0, modify: 0, delete: 0, skipped: 0,
    })
    await db.close()
  })

  it('3. ids are POSITIONALLY aligned with records', async () => {
    const { db, v } = await vault()
    for (let i = 0; i < 5; i++) await v.collection<Row>('rows').put(`r${i}`, { n: i })
    const parsed = JSON.parse(await v.exportJSON()) as { collections: Record<string, { records: Row[]; ids?: string[] }> }
    const { records, ids } = parsed.collections.rows!
    expect(ids!.length, 'ids and records are not the same length').toBe(records.length)
    // The alignment itself: each id's record must be the one at the same index.
    for (const [i, id] of ids!.entries()) {
      const live = await v.collection<Row>('rows').get(id)
      expect(live, `ids[${i}] does not name a live record`).not.toBeNull()
      expect(live!.n, `ids[${i}] is aligned with the wrong record`).toBe(records[i]!.n)
    }
    await db.close()
  })

  it('4. CONTROL: a FLAT candidate with no ids still keys by the record field', async () => {
    // The fallback. An older artefact, or a hand-built `{ coll: records[] }`,
    // must keep working exactly as before — which is also what makes `ids`
    // additive rather than a format break.
    const { db, v } = await vault()
    await v.collection<Row>('invoices').put('i1', { id: 'i1', n: 1 })
    const d = await diffVault(v, { invoices: [{ id: 'i1', n: 1 }] } as never)
    expect(d.summary).toMatchObject({ add: 0, modify: 0, delete: 0, skipped: 0 })
    await db.close()
  })

  it('5. CONTROL: a real difference is still reported', async () => {
    // Without this, every case above would also pass if the diff had been
    // turned into a blanket "no change".
    const { db, v } = await vault()
    await v.collection<Row>('invoices').put('i1', { id: 'i1', n: 1 })
    const json = await v.exportJSON()
    await v.collection<Row>('invoices').put('i1', { id: 'i1', n: 99 })
    await v.collection<Row>('invoices').put('i2', { id: 'i2', n: 2 })

    const d = await diffVault(v, json)
    expect(d.summary.modify, 'the changed record was not reported').toBe(1)
    expect(d.summary.delete, 'the record absent from the export was not reported').toBe(1)
    await db.close()
  })

  it('6. CONTROL: an artefact WITHOUT ids is read by field, not skipped', async () => {
    // Proves the `ids` branch is conditional rather than required: strip them
    // and the same artefact still diffs clean through the fallback.
    const { db, v } = await vault()
    await v.collection<Row>('invoices').put('i1', { id: 'i1', n: 1 })
    const parsed = JSON.parse(await v.exportJSON()) as { collections: Record<string, { ids?: string[] }> }
    delete parsed.collections.invoices!.ids
    const d = await diffVault(v, JSON.stringify(parsed))
    expect(d.summary).toMatchObject({ add: 0, modify: 0, delete: 0, skipped: 0 })
    await db.close()
  })
})
