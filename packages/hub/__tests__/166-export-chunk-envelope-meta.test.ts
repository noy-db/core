/**
 * family#166 — `ExportChunk` can carry each record's store-level `_v`/`_ts`.
 *
 * ⛔ THE PROPERTY UNDER TEST IS ALIGNMENT, not presence. `envelopeMeta[i]`
 * describes `records[i]`, and nothing in the type can enforce that: both are
 * arrays of the same length whatever order they were built in. So the cases
 * below correlate VALUES — records written a different number of times carry
 * different `_v` — rather than only counting entries. A length check alone
 * passes a producer that pushes metadata in a second loop over `ids`, which is
 * exactly the shape that shifts every version by one as soon as one record is
 * unreadable.
 *
 * ⚠️ Keyed by POSITION on purpose. A record need not carry an `id` field — the
 * id is the store key, not a property of the plaintext — so a `{ [id]: meta }`
 * map would drop every id-less record. That is family#151's `diffVault` defect,
 * and this type is published.
 *
 * ⛔ SEED IN THE FIRST INSTANCE, MEASURE ON A REOPENED ONE, per
 * `45-export-scope-narrows-read.test.ts`: hub serves reads from its decrypted
 * cache after hydration, so an export against the vault that just wrote the
 * records touches the store zero times and every counter reads 0 — a green
 * test measuring nothing.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { Noydb, NoydbStore, ExportChunk, ExportStreamOptions } from '../src/index.js'

interface Row { id: string; n: number }

const SECRET = 'pw-export-meta-166'

/** A store that counts record `get`s, so the cost claim is measured. */
function countingStore(): { store: NoydbStore; gets: string[] } {
  const inner = memoryStore()
  const gets: string[] = []
  const store = {
    ...inner,
    get: (v: string, c: string, id: string) => { gets.push(`${c}/${id}`); return inner.get(v, c, id) },
  } as NoydbStore
  return { store, gets }
}

/**
 * Three rows written a DIFFERENT number of times, so each has a distinct `_v`:
 * r1 → 1, r2 → 2, r3 → 3. That spread is what makes alignment observable.
 */
async function seeded(store: NoydbStore): Promise<Noydb> {
  const open = async (): Promise<Noydb> => await createNoydb({ store, user: 'owner-166', secret: SECRET })
  const first = await open()
  const vault = await first.openVault('acme')
  const rows = vault.collection<Row>('rows')
  await rows.put('r1', { id: 'r1', n: 1 })
  await rows.put('r2', { id: 'r2', n: 1 })
  await rows.put('r2', { id: 'r2', n: 2 })
  await rows.put('r3', { id: 'r3', n: 1 })
  await rows.put('r3', { id: 'r3', n: 2 })
  await rows.put('r3', { id: 'r3', n: 3 })
  await first.close()
  return await open()
}

const collect = async (it: AsyncIterable<ExportChunk>): Promise<ExportChunk[]> => {
  const out: ExportChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

describe('family#166 — envelopeMeta on ExportChunk', () => {
  it('is ABSENT by default — the control for every case below', async () => {
    // Without this, a producer that always attaches metadata would pass the
    // rest of this file while making the option meaningless.
    const db = await seeded(memoryStore())
    const vault = await db.openVault('acme')
    const [chunk] = await collect(vault.exportStream())
    expect(chunk?.envelopeMeta).toBeUndefined()
    expect('envelopeMeta' in (chunk as object)).toBe(false)
    await db.close()
  })

  it('aligns with records POSITIONALLY at collection granularity', async () => {
    const db = await seeded(memoryStore())
    const vault = await db.openVault('acme')
    const [chunk] = await collect(vault.exportStream({ withEnvelopeMeta: true }))
    const records = chunk!.records as Row[]
    const meta = chunk!.envelopeMeta!

    expect(meta).toHaveLength(records.length)
    // THE assertion: each record's reported version is ITS OWN. r1/r2/r3 were
    // written 1/2/3 times, so a producer that built the metadata in its own
    // loop — or sorted either array — fails here and passes a length check.
    const byId = new Map(records.map((r, i) => [r.id, meta[i]!]))
    expect(byId.get('r1')!.version).toBe(1)
    expect(byId.get('r2')!.version).toBe(2)
    expect(byId.get('r3')!.version).toBe(3)
    await db.close()
  })

  it('carries a real store timestamp, not a business field', async () => {
    const db = await seeded(memoryStore())
    const vault = await db.openVault('acme')
    const [chunk] = await collect(vault.exportStream({ withEnvelopeMeta: true }))
    for (const m of chunk!.envelopeMeta!) {
      expect(m.ts, 'a non-ISO or empty _ts means the envelope was not read').toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(Number.isFinite(Date.parse(m.ts))).toBe(true)
    }
    await db.close()
  })

  it('yields exactly one entry per chunk at record granularity', async () => {
    const db = await seeded(memoryStore())
    const vault = await db.openVault('acme')
    const chunks = await collect(vault.exportStream({ granularity: 'record', withEnvelopeMeta: true }))
    expect(chunks).toHaveLength(3)
    for (const c of chunks) {
      expect(c.records).toHaveLength(1)
      expect(c.envelopeMeta).toHaveLength(1)
      // Alignment again, in the shape where it is easiest to get wrong: one
      // chunk per record means the metadata must come from THAT id.
      expect(c.envelopeMeta![0]!.version).toBe((c.records[0] as Row).n)
    }
    await db.close()
  })

  /**
   * ⛔ ONE COLD INSTANCE PER ARM, and my first attempt got this wrong in a way
   * worth recording: both arms ran against the SAME reopened vault, so the
   * first export hydrated hub's decrypted cache and the second touched the
   * store zero times. The two numbers then differed by exactly the record
   * count — in whichever direction the arms happened to be ordered — and both
   * cost claims "failed", each one reporting the other's result. The
   * measurement was of RUN ORDER, not of the flag.
   *
   * The file header already carried the warning (seed first, measure on a
   * reopened one); reopening once is not enough when two measurements share the
   * instance.
   */
  const coldGets = async (opts: ExportStreamOptions): Promise<number> => {
    const counting = countingStore()
    const db = await seeded(counting.store)       // seeds, closes, reopens cold
    const vault = await db.openVault('acme')
    counting.gets.length = 0                      // ⚠️ the window opens after hydration
    await collect(vault.exportStream(opts))
    const n = counting.gets.filter((g) => g.startsWith('rows/')).length
    await db.close()
    return n
  }

  it('⭐ costs an UNSCOPED export nothing — the envelopes are already in hand', async () => {
    // The cost claim the option's opt-in-ness rests on. `resolveExportSource`
    // does one `loadAll` for an unscoped export, so the metadata is a map
    // lookup and `withEnvelopeMeta` must add no record `get` at all.
    const withMeta = await coldGets({ withEnvelopeMeta: true })
    const without = await coldGets({})
    expect(withMeta, 'an unscoped export paid for metadata it already held').toBe(without)
  })

  it('⭐ costs a SCOPED export one get per record — and only when asked', async () => {
    // The other half, and why this is a flag. A scoped export enumerates with
    // `list` and holds no envelopes (core#45b), so the metadata genuinely costs
    // a fetch — which a scoped export that does NOT ask must still not pay.
    const without = await coldGets({ collections: ['rows'] })
    const withMeta = await coldGets({ collections: ['rows'], withEnvelopeMeta: true })
    expect(withMeta - without, 'expected exactly one extra get per exported record').toBe(3)
  })
})
