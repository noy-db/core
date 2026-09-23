/**
 * core#103 — a bulk read that carries the hub-assigned id.
 *
 * pilot-1, writing a rule keyed on the record id: `list()` returns `T[]`, and
 * the id is not derivable from a record, so the id was reachable only through
 * the store contract plus a `get()` per row. An app that keeps its own key in
 * a field never notices; one that relies on the id hub assigned had no bulk
 * read at all.
 *
 * ⭐ `listPage()` DELEGATES to `listPageEntries()` rather than running its own
 * loop. Two reads of the same collection that could answer differently is the
 * defect a parallel implementation would introduce, and it is the reason the
 * agreement cases below are here rather than just the shape cases.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

interface D { body: string }
const S = 'correct horse battery staple'
const open = (store: NoydbStore, extra: Record<string, unknown> = {}) =>
  createNoydb({ store, user: 'owner', secret: S, validateSecret: false, ...extra })

async function seed(n = 3) {
  const store = memoryStore()
  const db = await open(store)
  const v = await db.openVault('v1')
  const c = v.collection<D>('notes')
  for (let i = 1; i <= n; i++) await c.put(`n${i}`, { body: `b${i}` })
  return { store, db, v, c }
}

describe('core#103 — listEntries / listPageEntries', () => {
  it('listEntries carries the id, in [id, record] order', async () => {
    const { c } = await seed()
    const entries = await c.listEntries()
    expect(entries.map(([id]) => id).sort()).toEqual(['n1', 'n2', 'n3'])
    const byId = Object.fromEntries(entries)
    expect(byId['n2']).toEqual({ body: 'b2' })
  })

  it('AGREES with list() on the records — same set, same order', async () => {
    const { c } = await seed()
    expect((await c.listEntries()).map(([, r]) => r)).toEqual(await c.list())
  })

  it('listPageEntries carries the id, and listPage agrees with it', async () => {
    const { c } = await seed(5)
    const page = await c.listPageEntries({ limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.items.every(([id]) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(page.nextCursor).not.toBeNull()

    const plain = await c.listPage({ limit: 2 })
    expect(plain.items).toEqual(page.items.map(([, r]) => r))
    expect(plain.nextCursor).toBe(page.nextCursor)
  })

  it('pages all the way through and the ids are the whole collection, once each', async () => {
    const { c } = await seed(5)
    const seen: string[] = []
    let cursor: string | null | undefined
    do {
      const p = await c.listPageEntries({ limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...p.items.map(([id]) => id))
      cursor = p.nextCursor
    } while (cursor)
    expect(seen.sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('refuses in lazy mode exactly as list() does, and names the paging alternative', async () => {
    const store = memoryStore()
    const db = await open(store)
    const v = await db.openVault('v1')
    // ⚠️ A DIFFERENT collection name on purpose. `vault.collection()` caches
    // by NAME and ignores the options on a second call, so asking for
    // `{ prefetch: false }` after the collection has been opened eagerly hands
    // back the eager instance — and the lazy refusal never fires. That cost a
    // failing run here; it would cost a consumer a silently eager read.
    await v.collection<D>('other').put('n1', { body: 'b1' })
    const lazy = v.collection<D>('lazyone', { prefetch: false, cache: { maxRecords: 10 } })
    await lazy.put('n1', { body: 'b1' })
    await expect(lazy.listEntries()).rejects.toThrow(/not available in lazy mode/)
    await expect(lazy.listEntries()).rejects.toThrow(/listPageEntries/)
    await expect(lazy.list()).rejects.toThrow(/not available in lazy mode/)
  })
})
