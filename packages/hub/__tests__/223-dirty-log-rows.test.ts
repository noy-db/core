/**
 * family#223 — every tracked write re-saved the WHOLE `_sync/meta` dirty list.
 *
 * ## Measured on main before the change
 *
 * | N writes | bytes written to `_sync` |
 * |---|---|
 * | 50 | 179,995 |
 * | 100 | 699,945 |
 * | 200 | 2,764,895 |
 *
 * 3.9× per doubling — O(N²). Extrapolating gives ~276 MB at N=2,000, matching
 * the 226 MB reported from the field, where it froze a browser import twice.
 *
 * ⭐ TWO quadratic factors, not one: `persistMeta()` re-serialised the list on
 * every `trackChange`, AND the dedupe was an O(N) `findIndex`. Fixing only the
 * serialisation leaves the same shape, slower to notice.
 *
 * ## After: one row per entry
 *
 * ~218 bytes per write, flat, and `_sync/meta` is not written on the write path
 * at all (nothing in it changes). Dedupe is the same row key overwritten.
 *
 * ⛔ NOT DEBOUNCED, which was the cheaper change and is refused: the record is
 * already in the local store, so a lost dirty MARK is a record that exists
 * locally and is never pushed, with nothing to indicate it. That trades a slow
 * import for silent divergence, and in a browser an unclean shutdown is a
 * closed tab.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { buildRecordEnvelope } from '../src/capsule/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, DirtyEntry } from '../src/kernel/types.js'

function counting() {
  const data = new Map<string, EncryptedEnvelope>()
  const bytes: Record<string, number> = {}
  const puts: Record<string, number> = {}
  const k = (v: string, c: string, i: string) => `${v}|${c}|${i}`
  const store = {
    name: 'counting',
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v: string, c: string, i: string) { return data.get(k(v, c, i)) ?? null },
    async put(v: string, c: string, i: string, e: EncryptedEnvelope) {
      bytes[c] = (bytes[c] ?? 0) + JSON.stringify(e).length
      puts[c] = (puts[c] ?? 0) + 1
      data.set(k(v, c, i), e)
    },
    async delete(v: string, c: string, i: string) { data.delete(k(v, c, i)) },
    async list(v: string, c: string) {
      const p = `${v}|${c}|`
      return [...data.keys()].filter((x) => x.startsWith(p)).map((x) => x.slice(p.length))
    },
    async loadAll(v: string) {
      const s: VaultSnapshot = {}
      for (const [key, e] of data) {
        const [vn, cn, id] = key.split('|')
        if (vn === v && cn && id && !cn.startsWith('_')) { s[cn] = s[cn] ?? {}; s[cn]![id] = e }
      }
      return s
    },
    async saveAll() {},
  } as unknown as NoydbStore
  return { store, bytes, puts, data }
}

interface Row extends Record<string, unknown> { n: number }
const SECRET = 'pw-223-dirty-rows-long'

async function writeN(N: number, local = counting()) {
  const db = await createNoydb({
    store: local.store, sync: counting().store, user: 'owner', secret: SECRET,
    validateSecret: false, syncStrategy: withSync(),
  })
  const v = await db.openVault('acme')
  const c = v.collection<Row>('rows')
  for (let i = 0; i < N; i++) await c.put(`r${i}`, { n: i })
  return { db, v, local }
}

describe('family#223 — the dirty log is one row per entry', () => {
  it('1. THE BUG: the cost per tracked write is CONSTANT, not growing', async () => {
    // The assertion is the SHAPE, not a byte budget: a per-write cost that is
    // flat within a few percent across an 8× range cannot be quadratic, and a
    // threshold on absolute bytes would rot with every field added to an entry.
    const perWrite: number[] = []
    for (const N of [50, 100, 200, 400]) {
      const { db, local } = await writeN(N)
      const queueBytes = (local.bytes._sync_dirty ?? 0) + (local.bytes._sync ?? 0)
      perWrite.push(queueBytes / N)
      await db.close()
    }
    const [first] = perWrite
    for (const [i, cost] of perWrite.entries()) {
      expect(cost / first!, `per-write cost grew at index ${i} — the queue is re-serialised again`).toBeLessThan(1.2)
    }
    // And the old shape would have failed this outright: at N=400 the quadratic
    // version wrote ~11 MB, which is >100x what a flat cost produces.
    expect(perWrite.at(-1)! * 400, 'N=400 wrote far more than a per-entry queue should').toBeLessThan(500_000)
  })

  it('2. `_sync/meta` is NOT written on the write path', async () => {
    // Nothing in meta changes when a record becomes dirty — `last_push`,
    // `last_pull` and `epoch` are all untouched — so writing it was pure cost.
    const { db, local } = await writeN(100)
    expect(local.puts._sync ?? 0, 'meta was re-written per tracked write').toBe(0)
    expect(local.puts._sync_dirty, 'one row per write').toBe(100)
    await db.close()
  })

  it('3. the queue survives a fresh instance and still PUSHES', async () => {
    // The crash-shaped case: writes, no push, a new engine over the same
    // store. A debounce would lose these, which is why it was refused.
    //
    // ⚠️ Asserted through the PUSH, not through `syncStatus().dirty`, and the
    // distinction cost me a false failure. `ensureLoaded` is lazy, so
    // `syncStatus` reads 0 immediately after an open until something triggers
    // a load — verified to be the behaviour on main as well, so it is
    // pre-existing and not this change. The property that matters is that the
    // records actually reach the remote.
    const remote = counting()
    const { db, local } = await writeN(25)
    await db.close()
    const db2 = await createNoydb({
      store: local.store, sync: remote.store, user: 'owner', secret: SECRET,
      validateSecret: false, syncStrategy: withSync(),
    })
    await db2.openVault('acme')
    await db2.push('acme')
    expect((await remote.store.list('acme', 'rows')).length, 'the queue did not survive the reopen').toBe(25)
    await db2.close()
  })

  it('4. a dedupe overwrites one row rather than adding one', async () => {
    const local = counting()
    const db = await createNoydb({
      store: local.store, sync: counting().store, user: 'owner', secret: SECRET,
      validateSecret: false, syncStrategy: withSync(),
    })
    const v = await db.openVault('acme')
    for (let w = 0; w < 10; w++) await v.collection<Row>('rows').put('same', { n: w })
    expect(await local.store.list('acme', '_sync_dirty'), 'ten writes of one id left more than one row').toHaveLength(1)
    expect(db.syncStatus('acme').dirty).toBe(1)
    await db.close()
  })

  it('5. a push clears the rows, not just the array', async () => {
    // A stale row would RESURRECT a pushed record on the next load — worse
    // than the bug this fixes.
    const { db, local } = await writeN(12)
    await db.push('acme')
    expect(await local.store.list('acme', '_sync_dirty'), 'pushed entries left rows behind').toEqual([])
    expect(db.syncStatus('acme').dirty).toBe(0)
    await db.close()
  })

  it('6. ⛔ MIGRATION: a queue in the OLD in-meta layout is carried over, then emptied', async () => {
    // The load-bearing half. A queue in flight across the upgrade lives in
    // `_sync/meta`'s list; without this those records would be silently
    // dropped from the queue — the very failure the row was filed for, caused
    // by its own fix.
    const local = counting()
    const legacy: DirtyEntry[] = [
      { vault: 'acme', collection: 'rows', id: 'old1', action: 'put', version: 1, timestamp: '2026-10-14T00:00:00Z' },
      { vault: 'acme', collection: 'rows', id: 'old2', action: 'put', version: 1, timestamp: '2026-10-14T00:00:00Z' },
    ]
    // Seed a pre-upgrade store: the records themselves plus an old-style meta.
    const seed = await createNoydb({ store: local.store, user: 'owner', secret: SECRET, validateSecret: false })
    const sv = await seed.openVault('acme')
    await sv.collection<Row>('rows').put('old1', { n: 1 })
    await sv.collection<Row>('rows').put('old2', { n: 2 })
    await seed.close()
    await local.store.put('acme', '_sync', 'meta', buildRecordEnvelope(
      { collection: '_sync', id: 'meta', version: 1 },
      { iv: '', data: JSON.stringify({ _noydb_sync: 1, last_push: null, last_pull: null, dirty: legacy }) },
    ))

    const remote = counting()
    const db = await createNoydb({
      store: local.store, sync: remote.store, user: 'owner', secret: SECRET,
      validateSecret: false, syncStrategy: withSync(),
    })
    await db.openVault('acme')
    // Through the push, for the reason case 3 records.
    await db.push('acme')
    expect((await remote.store.list('acme', 'rows')).sort(), 'the in-flight queue was dropped on upgrade').toEqual(['old1', 'old2'])
    expect((await local.store.list('acme', '_sync_dirty')).length, 'pushed carried entries left rows behind').toBe(0)

    // Idempotent: the field is emptied, so a second load carries nothing twice.
    const meta = await local.store.get('acme', '_sync', 'meta')
    expect(JSON.parse(meta!._data!).dirty, 'the old field was not emptied — a reload would double-carry').toEqual([])
    await db.close()
  })

  it('7. CONTROL: the pushed records actually arrive', async () => {
    // Without this, every case above would pass if the queue simply stopped
    // working.
    const remote = counting()
    const local = counting()
    const db = await createNoydb({
      store: local.store, sync: remote.store, user: 'owner', secret: SECRET,
      validateSecret: false, syncStrategy: withSync(),
    })
    const v = await db.openVault('acme')
    for (let i = 0; i < 5; i++) await v.collection<Row>('rows').put(`r${i}`, { n: i })
    await db.push('acme')
    expect((await remote.store.list('acme', 'rows')).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
    await db.close()
  })
})
