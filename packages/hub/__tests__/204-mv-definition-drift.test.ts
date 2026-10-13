/**
 * family#204 — a changed materialized-view definition was not detected on
 * reopen, so old-key rows survived beside the new ones.
 *
 * ⛔ `queryHash` was WRITTEN AND NEVER READ. `query-hash.ts` states it exists
 * "to detect strategy drift: a row whose `_materializedFrom.queryHash` doesn't
 * match the current strategy is considered stale", and `registry.ts` claims a
 * predicate change "forces refresh on next visit" — but nothing anywhere
 * compared it. Every `_materializedFrom` read was for `mvName`, for ownership.
 * Measured: `grep "queryHash !==" src/` returned nothing.
 *
 * ⭐ Marking the MV stale is the WHOLE fix: the recompute on next read already
 * runs the executor, whose tombstone leg deletes any stamped row absent from the
 * new id set, and `onEmpty` defaults to `'delete'` (executor.ts:592). No new
 * purge path.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, withMaterializedView } from '../src/index.js'
import type { NoydbStore } from '../src/index.js'

const SECRET = 'correct horse battery staple river stone'
interface Sale extends Record<string, unknown> { id: string; region: string; amount: number }

/**
 * The same MV under two definitions, differing in their QUERY.
 *
 * ⚠️ IT HAS TO BE THE QUERY. `computeQueryHash` hashes mvName + dependency set
 * + `summarizeQueryPlan`, and NOT `rowKey` — so a changed `rowKey` alone
 * produces an identical hash and is structurally invisible to drift detection.
 * My first fixture changed only the `rowKey` prefix and therefore created no
 * drift at all; the test failed because the fixture was wrong, not the fix.
 * See the PR for that limitation, which this change does not close.
 */
function mvFiltered(minAmount: number) {
  return withMaterializedView({
    name: 'byRegion',
    query: (db: never) => (db as unknown as {
      collection: (n: string) => { query: () => { where: (f: string, op: string, v: unknown) => unknown } }
    }).collection('sales').query().where('amount', '>=', minAmount),
    rowKey: (r: Sale) => `R:${r.region}`,
    sources: ['sales'],
    refresh: 'eager',
    output: { collection: 'sales_rollup' },
  } as never)
}

async function open(store: NoydbStore, minAmount: number) {
  const db = await createNoydb({
    store, user: 'o', secret: SECRET, validateSecret: false,
    materializedViewStrategies: [mvFiltered(minAmount)],
  } as never)
  return { db, v: await db.openVault('acme') }
}

const rollupIds = async (v: Awaited<ReturnType<typeof open>>['v']): Promise<string[]> =>
  (await v.collection<Record<string, unknown>>('sales_rollup').listEntries()).map(([id]) => id).sort()

describe('family#204 — a changed MV definition is detected on reopen', () => {
  it('⭐ a row the NEW definition excludes does not survive the reopen', async () => {
    const store = memoryStore({ full: true })

    // Session 1: the filter admits the row, so it is materialized.
    const one = await open(store, 0)
    await one.v.collection<Sale>('sales').put('s1', { id: 's1', region: 'north', amount: 10 })
    expect(await rollupIds(one.v), 'fixture: the permissive definition did not emit').toEqual(['R:north'])
    await one.db.close()

    // Session 2: a STRICTER filter excludes it. The stored row is now wrong,
    // and before this fix it survived until an unrelated source write.
    const two = await open(store, 100)
    expect(
      await rollupIds(two.v),
      'a row excluded by the new definition survived the reopen',
    ).toEqual([])
    await two.db.close()
  })

  it('CONTROL: an UNCHANGED definition does not force a rebuild on reopen', async () => {
    // ⚠️ The per-open cost guard. Without it the fix could be written as
    // "always rebuild on open", which passes the case above and makes every
    // cold read pay for a full refresh. `materializedAt` is the witness: a
    // rebuild rewrites it.
    const store = memoryStore({ full: true })
    const one = await open(store, 0)
    await one.v.collection<Sale>('sales').put('s1', { id: 's1', region: 'north', amount: 10 })
    const stampedAt = async (v: Awaited<ReturnType<typeof open>>['v']): Promise<string> => {
      // ⚠️ Indexed access is checked here (`noUncheckedIndexedAccess`), and
      // `vitest` does NOT typecheck — a destructuring `const [[, row]] = …`
      // ran green all the way to `pnpm typecheck`, which is the separate gate.
      const entries = await v.collection<Record<string, unknown>>('sales_rollup').listEntries()
      const first = entries[0]
      expect(first, 'fixture: no rollup row to read a stamp from').toBeDefined()
      const stamp = first![1]._materializedFrom as Record<string, unknown>
      return String(stamp.materializedAt)
    }
    const before = await stampedAt(one.v)
    await one.db.close()

    const two = await open(store, 0) // same definition
    expect(await stampedAt(two.v), 'an unchanged definition triggered a rebuild').toBe(before)
    await two.db.close()
  })

  it('CONTROL: a row stamped by a DIFFERENT MV is left alone', async () => {
    // The `mvName` ownership discipline must hold — the drift check must not
    // judge, or restamp, another MV's rows sharing the output collection.
    const store = memoryStore({ full: true })
    const other = withMaterializedView({
      name: 'otherMV',
      query: (db: never) => (db as unknown as { collection: (n: string) => { query: () => unknown } })
        .collection('sales').query(),
      rowKey: (r: Sale) => `O:${r.id}`,
      sources: ['sales'],
      refresh: 'eager',
      output: { collection: 'sales_rollup' },
    } as never)
    const db = await createNoydb({
      store, user: 'o', secret: SECRET, validateSecret: false,
      materializedViewStrategies: [mvFiltered(0), other],
    } as never)
    const v = await db.openVault('acme')
    await v.collection<Sale>('sales').put('s1', { id: 's1', region: 'north', amount: 10 })
    const ids = (await v.collection<Record<string, unknown>>('sales_rollup').listEntries()).map(([i]) => i).sort()
    expect(ids, 'both MVs should own their own rows').toEqual(['O:s1', 'R:north'])
    await db.close()
  })
})
