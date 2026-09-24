import { describe, it, expect } from 'vitest'
import { memoryStore } from '../src/kernel/memory-store.js'
import type { EncryptedEnvelope } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

const env = (v: number): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: '2026-01-01T00:00:00.000Z', _iv: '', _data: `d${v}` }) as unknown as EncryptedEnvelope

describe('memoryStore', () => {
  it('put then get returns the envelope; missing returns null', async () => {
    const s = memoryStore()
    expect(await s.get('v', 'c', '1')).toBeNull()
    await s.put('v', 'c', '1', env(0))
    expect((await s.get('v', 'c', '1'))?._data).toBe('d0')
  })

  it('list returns ids; delete removes', async () => {
    const s = memoryStore()
    await s.put('v', 'c', 'a', env(0))
    await s.put('v', 'c', 'b', env(0))
    expect((await s.list('v', 'c')).sort()).toEqual(['a', 'b'])
    await s.delete('v', 'c', 'a')
    expect(await s.list('v', 'c')).toEqual(['b'])
  })

  it('CAS: put with stale expectedVersion throws ConflictError', async () => {
    const s = memoryStore()
    await s.put('v', 'c', '1', env(5))
    await expect(s.put('v', 'c', '1', env(6), 4)).rejects.toBeInstanceOf(ConflictError)
    await s.put('v', 'c', '1', env(6), 5) // matching version succeeds
    expect((await s.get('v', 'c', '1'))?._v).toBe(6)
  })

  /**
   * core#134 — what `expectedVersion` means against an id that does not exist
   * yet. The reference store compares only when the record is present, so the
   * FIRST create is unguarded; but every version hub writes starts at 1, so
   * the SECOND create mismatches and throws. `expectedVersion: 0` is therefore
   * already an exact "must not exist" on this store — the contract needs no
   * new sentinel and no seventh method, only an assertion.
   *
   * ⭐ Measured, not reasoned: `memoryStore.put` was instrumented to report any
   * stored envelope with `_v < 1` and the whole hub suite run (7,054 tests).
   * The only hits were this file's own `env(0)` fixtures — no hub code path
   * stores version 0. That is what makes 0 safe to overload.
   *
   * ⛔ DO NOT adopt `expectedVersion: 0` at hub's create sites on the strength
   * of this test. It pins the READ-THEN-WRITE family (`memoryStore`,
   * `to-file`, `to-browser-idb` all compare only when present). A store doing
   * NATIVE conditional CAS would express the same call as "exists AND _v = 0"
   * and reject the first create outright — the opposite answer, on the one
   * case that matters. Nineteen `to-*` adapters live out of tree and
   * `@noy-db/ports/to` asserts neither half, so which way it goes is
   * currently a per-adapter accident. Pinning it is a store-contract change
   * and belongs to the family layer, not to hub.
   */
  it('CAS: expectedVersion 0 lets the FIRST create through and conflicts the SECOND (core#134)', async () => {
    const s = memoryStore()

    // Absent id: the comparison does not happen at all, so the write lands.
    await s.put('v', 'c', 'fresh', env(1), 0)
    expect((await s.get('v', 'c', 'fresh'))?._v).toBe(1)

    // A second creator of the same id now mismatches, because the record it
    // believed was absent is present at _v 1. This is the create race being
    // caught — the thing core#134 was filed believing impossible.
    await expect(s.put('v', 'c', 'fresh', env(1), 0)).rejects.toBeInstanceOf(ConflictError)
    expect((await s.get('v', 'c', 'fresh'))?._data).toBe('d1')
  })

  it('loadAll returns a snapshot excluding _system collections; saveAll replaces user collections', async () => {
    const s = memoryStore()
    await s.put('v', 'items', '1', env(0))
    await s.put('v', '_idx', 'x', env(0)) // system collection — excluded from loadAll
    expect(await s.loadAll('v')).toEqual({ items: { '1': env(0) } })

    await s.saveAll('v', { items: { '2': env(0) } })
    expect(await s.list('v', 'items')).toEqual(['2']) // user collection replaced
    expect(await s.list('v', '_idx')).toEqual(['x']) // system collection preserved
  })

  it('declares casAtomic + a monotonic store clock', async () => {
    const s = memoryStore()
    expect(s.capabilities?.casAtomic).toBe(true)
    const t1 = await s.getStoreTime!()
    const t2 = await s.getStoreTime!()
    expect(t2.earliest).toBeGreaterThan(t1.earliest)
  })

  it('listPage returns paginated results with stable sorting (by id) and correct cursor', async () => {
    const s = memoryStore()
    // Seed out of lexicographic order so the sort() guarantee is actually exercised
    // (Map preserves insertion order; without sort, page 1 would be ['c','a']).
    await s.put('v', 'c', 'c', env(0))
    await s.put('v', 'c', 'a', env(0))
    await s.put('v', 'c', 'b', env(0))

    // First page: 2 items (limit 2)
    const page1 = await s.listPage!('v', 'c', undefined, 2)
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]?.id).toBe('a')
    expect(page1.items[1]?.id).toBe('b')
    expect(page1.nextCursor).toBe('2')

    // Second page: 1 item remaining
    const page2 = await s.listPage!('v', 'c', '2', 2)
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]?.id).toBe('c')
    expect(page2.nextCursor).toBeNull()

    // Empty collection
    const emptyPage = await s.listPage!('v', 'nonexistent', undefined, 10)
    expect(emptyPage.items).toEqual([])
    expect(emptyPage.nextCursor).toBeNull()
  })
})
