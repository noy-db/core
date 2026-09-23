/**
 * core#76 — `vault.restoreTo(T)`: point-in-time restore as forward writes.
 *
 * Case C of the backup model: the store drifted and the admin wants a previous
 * state back, without a full pod. `vault.at(T)` already reconstructs any
 * record at T and is read-only by contract; this writes that reconstruction.
 *
 * ⭐ The writes go through `Collection.put`/`.delete`, so the restore is an
 * ordinary audited event — which is why the last case here asserts a restore
 * can itself be restored. A "restore" that produced state no subsequent
 * restore could reach would be state replacement wearing a write's clothes.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
interface D { id: string; body: string }
const wait = (): Promise<void> => new Promise(r => setTimeout(r, 5))

const open = (store: NoydbStore) =>
  createNoydb({ store, user: 'owner', secret: S, validateSecret: false, historyStrategy: withHistory() })

/** three notes, then T, then drift: n1 edited, n2 deleted, n9 added. */
async function driftedVault() {
  const store = memoryStore()
  const db = await open(store)
  const v = await db.openVault('v1')
  const c = v.collection<D>('notes')
  await c.put('n1', { id: 'n1', body: 'ONE' })
  await c.put('n2', { id: 'n2', body: 'TWO' })
  await c.put('n3', { id: 'n3', body: 'THREE' })
  await wait()
  const T = new Date().toISOString()
  await wait()
  await c.put('n1', { id: 'n1', body: 'EDITED' })
  await c.delete('n2')
  await c.put('n9', { id: 'n9', body: 'NEW' })
  return { store, db, v, c, T }
}

describe('core#76 — restoreTo(T)', () => {
  it('puts back what changed, restores what was deleted, removes what did not exist at T', async () => {
    const { v, c, T } = await driftedVault()
    const r = await v.restoreTo(T)

    expect(await c.get('n1')).toEqual({ id: 'n1', body: 'ONE' })    // edit undone
    expect(await c.get('n2')).toEqual({ id: 'n2', body: 'TWO' })    // delete undone
    expect(await c.get('n3')).toEqual({ id: 'n3', body: 'THREE' })  // untouched
    expect(await c.get('n9')).toBeNull()                            // post-T record removed

    expect(r.dryRun).toBe(false)
    expect(r.collections['notes']!.written.sort()).toEqual(['n1', 'n2'])
    expect(r.collections['notes']!.deleted).toEqual(['n9'])
    expect(r.unchanged).toBe(1)
  })

  it('dryRun reports the same diff and writes NOTHING', async () => {
    const { c, v, T } = await driftedVault()
    const plan = await v.restoreTo(T, { dryRun: true })

    expect(plan.dryRun).toBe(true)
    expect(plan.collections['notes']!.written.sort()).toEqual(['n1', 'n2'])
    expect(plan.collections['notes']!.deleted).toEqual(['n9'])

    // ⭐ the control that makes dryRun mean something: the store is untouched
    expect(await c.get('n1')).toEqual({ id: 'n1', body: 'EDITED' })
    expect(await c.get('n9')).toEqual({ id: 'n9', body: 'NEW' })
    expect(await c.get('n2')).toBeNull()

    // and committing it produces exactly what the plan said
    const done = await v.restoreTo(T)
    expect(done.collections['notes']!.written.sort()).toEqual(plan.collections['notes']!.written.sort())
    expect(done.collections['notes']!.deleted).toEqual(plan.collections['notes']!.deleted)
  })

  it('the restore is FORWARD writes — history keeps going, and the restore is itself restorable', async () => {
    const { v, c, T } = await driftedVault()
    await wait()
    const beforeRestore = new Date().toISOString()
    await wait()
    await v.restoreTo(T)
    expect(await c.get('n1')).toEqual({ id: 'n1', body: 'ONE' })

    // ⭐ nothing was rewritten: the drifted state is still reachable at its own
    // instant, and restoring to it undoes the restore.
    await v.restoreTo(beforeRestore)
    expect(await c.get('n1')).toEqual({ id: 'n1', body: 'EDITED' })
    expect(await c.get('n9')).toEqual({ id: 'n9', body: 'NEW' })
  })

  it('scopes to named collections and leaves the others alone', async () => {
    const { v, T } = await driftedVault()
    const other = v.collection<D>('other')
    await other.put('o1', { id: 'o1', body: 'AFTER-T' })

    const r = await v.restoreTo(T, { collections: ['notes'] })
    expect(Object.keys(r.collections)).toEqual(['notes'])
    expect(await other.get('o1')).toEqual({ id: 'o1', body: 'AFTER-T' })  // untouched
  })

  it('a collection present ONLY in history is still considered — tested at the seam, and here is why', async () => {
    // ⚠️ This cannot be produced through `memoryStore`: its `loadAll` keeps a
    // collection key once created, even after every row is deleted, so the
    // collection is never absent from the live set. On a real adapter
    // (DynamoDB, SQL) an emptied collection DOES vanish — which is exactly
    // when a restore that walked only live collections would decline to bring
    // back a collection dropped since T.
    //
    // ⛔ Two earlier versions of this case passed with the history lookup
    // REMOVED, which is how the gap was found. Rather than keep a row that
    // asserts nothing, the union is exercised directly against the exported
    // entry point with a host whose live set is empty.
    const { restoreTo } = await import('../src/with-commit/history/restore-to.js')
    const past = new Map([['g1', { id: 'g1', body: 'G' }]])
    const live = new Map<string, D>()
    const seen: string[] = []
    const r = await restoreTo({
      adapter: {
        // history holds one snapshot, naming a collection the live set lacks
        list: async (_v: string, c: string) => (c === '_history' ? ['gone:g1:1'] : [...live.keys()]),
      } as unknown as NoydbStore,
      vault: 'v1',
      instantCollection: (name) => ({
        list: async () => (name === 'gone' ? [...past.keys()] : []),
        get: async (id: string) => (name === 'gone' ? past.get(id) ?? null : null),
      }),
      liveCollection: (name) => {
        seen.push(name)
        return {
          get: async (id: string) => live.get(id) ?? null,
          put: async (id: string, rec: unknown) => { live.set(id, rec as D) },
          delete: async (id: string) => { live.delete(id) },
          list: async () => [...live.values()],
        }
      },
      liveCollectionNames: async () => [],          // ⭐ the live set is EMPTY
    }, new Date().toISOString())

    expect(seen).toContain('gone')                   // discovered from history alone
    expect(r.collections['gone']!.written).toEqual(['g1'])
    expect(live.get('g1')).toEqual({ id: 'g1', body: 'G' })
  })
})
