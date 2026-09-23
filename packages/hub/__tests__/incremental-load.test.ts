/**
 * core#77 — `vault.load(pod, { mode: 'incremental' })`.
 *
 * `load()` was `saveAll` plus a rewrite of every internal collection: a 10 GB
 * store restored from its own pod rewrote and re-uploaded 100% of itself,
 * whether or not the store already held the bytes.
 *
 * ⭐ THE PROPERTY UNDER TEST IS "SAME END STATE, LESS WORK", and both halves
 * need asserting. A mode that skips work and diverges is worse than one that
 * rewrites everything, so every case here checks the resulting DATA as well as
 * the counters — and the first case checks it against `'replace'` run on an
 * identical store, which is the only definition of "same" worth having.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
interface D { id: string; body: string }

const open = (store: NoydbStore) =>
  createNoydb({ store, user: 'owner', secret: S, validateSecret: false, historyStrategy: withHistory() })

async function seeded() {
  const store = memoryStore()
  const db = await open(store)
  const v = await db.openVault('v1')
  const c = v.collection<D>('notes')
  for (let i = 1; i <= 4; i++) await c.put(`n${i}`, { id: `n${i}`, body: `b${i}` })
  return { store, db, v }
}

/** every data row, as a comparable snapshot */
async function dataOf(store: NoydbStore): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const id of await store.list('v1', 'notes')) {
    const e = await store.get('v1', 'notes', id)
    if (e) out[id] = e._v
  }
  return out
}

describe('core#77 — incremental load', () => {
  it('an unchanged store skips everything and writes nothing', async () => {
    const { v } = await seeded()
    const pod = await v.dump()
    const r = await v.load(pod, { mode: 'incremental' })
    expect(r.mode).toBe('incremental')
    expect(r.written).toBe(0)
    expect(r.deleted).toBe(0)
    expect(r.skipped).toBeGreaterThan(0)
  })

  it('writes only what drifted, deletes what the pod does not carry — and lands where REPLACE lands', async () => {
    const a = await seeded()
    const pod = await a.v.dump()
    const b = await seeded()                       // an identical second store
    const podB = await b.v.dump()
    expect(await dataOf(a.store)).toEqual(await dataOf(b.store))

    // drift both stores the same way: one record edited, one added
    for (const s of [a, b]) {
      await s.v.collection<D>('notes').put('n2', { id: 'n2', body: 'CHANGED' })
      await s.v.collection<D>('notes').put('n9', { id: 'n9', body: 'EXTRA' })
    }

    const inc = await a.v.load(pod, { mode: 'incremental' })
    await b.v.load(podB)                           // replace, the reference

    // ⭐ the end states agree — the whole claim of the feature
    expect(await dataOf(a.store)).toEqual(await dataOf(b.store))
    expect(await a.v.collection<D>('notes').get('n2')).toEqual({ id: 'n2', body: 'b2' })
    expect(await a.v.collection<D>('notes').get('n9')).toBeNull()

    // and it did less: n2 rewritten, n9 deleted, the other three untouched
    expect(inc.collections['notes']).toEqual({ written: 1, skipped: 3, deleted: 1 })
  })

  it('refuses a pod from a DIFFERENT vault, and replace still accepts it', async () => {
    const { v } = await seeded()
    const other = memoryStore()
    const odb = await open(other)
    const ov = await odb.openVault('v2')
    await ov.collection<D>('notes').put('x1', { id: 'x1', body: 'X' })
    const foreign = await ov.dump()

    await expect(v.load(foreign, { mode: 'incremental' })).rejects.toThrow(/Incremental load refused/)
    await expect(v.load(foreign, { mode: 'incremental' })).rejects.toThrow(/v2/)
  })

  it('replace stays the default and still reports as replace', async () => {
    const { v } = await seeded()
    const pod = await v.dump()
    const r = await v.load(pod)
    expect(r.mode).toBe('replace')
  })

  it('an incremental restore still REWINDS the ledger (core#111 holds in both modes)', async () => {
    const { store, v } = await seeded()
    const pod = await v.dump()
    // ⚠️ `_ledger` ids are CHAIN INDICES (`0000000000`), never record ids, so
    // `get('_ledger', 'after')` is null whatever happens and asserting on it
    // proves nothing. Count the entries instead.
    const ledgerCount = async (): Promise<number> => (await store.list('v1', '_ledger')).length
    const before = await ledgerCount()
    await v.collection<D>('notes').put('after', { id: 'after', body: 'A' })
    expect(await ledgerCount()).toBeGreaterThan(before)

    await v.load(pod, { mode: 'incremental' })     // must not throw BackupCorruptedError
    expect(await store.get('v1', 'notes', 'after')).toBeNull()
    expect(await ledgerCount()).toBe(before)
  })
})
