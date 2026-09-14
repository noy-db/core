/**
 * #33 — a `via()`-spelled computed field must not be SILENTLY DISCARDED on a
 * late-attach (reconcile) `vault.collection()` call. It behaves exactly as the
 * `computed:` sugar key does: a virtual entry is refused, a materialized one
 * attaches.
 *
 * ⛔ WHAT IT COST. The two spellings disagreed, and only one of them said so:
 *
 *   computed: { f: { fn, mode: 'virtual' } }          → ValidationError (loud)
 *   viaFields: { f: via(computed(fn, { mode: 'virtual' })) } → silently dropped
 *
 * The field then did not exist at all, so every downstream reader degraded
 * quietly: `get()` omitted it, `groupBy` folded every row into one bucket keyed
 * `undefined`, and #29's posture gate could not fire because there was no
 * posture left to consult. pilot-1 hit this through a query-form materialized
 * view — MV registration opens its source collection first, which makes the
 * consumer's own declaration the reconcile call.
 *
 * ⭐ ROOT CAUSE, and why it was invisible: `reconcileViaAttach` computed the
 * MERGED view of both spellings for its collision guard, then used the RAW
 * sugar key for validation and apply. `effectiveViaFields.computedFields`
 * appeared exactly once in the file — in the guard. Worse, validation was
 * gated on `plan.computed`, so a call carrying ONLY `viaFields` ran no
 * validation whatsoever.
 *
 * ⚠️ The premise controls below are not ceremony. The first version of this
 * test measured a field that had never been declared at all, and "it threw"
 * meant nothing; absence and refusal are indistinguishable unless you first
 * prove the declaration takes effect when it should.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { via } from '../src/kernel/via/compose.js'
import { computed } from '../src/via/computed/descriptor.js'
import { count, withReduce } from '../src/with-lookup/reduce/index.js'

interface Item extends Record<string, unknown> { id: string; tag: string; virtTag?: string; upper?: string }

const VIRTUAL = { virtTag: via(computed((r) => `T-${r.tag as string}`, { deps: ['tag'], mode: 'virtual' })) }
const MATERIALIZED = { upper: via(computed((r) => String(r.tag).toUpperCase(), { deps: ['tag'] })) }

async function vault() {
  const db = await createNoydb({ store: memoryStore(), user: 'o', secret: 'issue-33-reconcile-viafields' })
  return db.openVault('V')
}

describe('#33 — viaFields on a reconcile call', () => {
  it('PREMISE: on a FIRST call the same declaration attaches — both spellings', async () => {
    // Without this the refusals below could be satisfied by a declaration that
    // never works at all, which is exactly how the first draft of this file
    // fooled its author.
    const v = await vault()
    const c = v.collection<Item>('first', { viaFields: { ...VIRTUAL, ...MATERIALIZED } } as never)
    await c.put('a', { id: 'a', tag: 'a' })
    const rec = await c.get('a')
    expect(rec?.virtTag).toBe('T-a')
    expect(rec?.upper).toBe('A')
  })

  it('refuses a VIRTUAL via()-spelled computed field, exactly as the `computed:` sugar does', async () => {
    const v = await vault()
    v.collection<Item>('late') // first call — no field declarations
    expect(() => v.collection<Item>('late', { viaFields: VIRTUAL } as never))
      .toThrow(/construction-only|virtual/)
  })

  it('CONTROL: the `computed:` sugar spelling refuses the same thing — the behaviour being matched', async () => {
    const v = await vault()
    v.collection<Item>('late2')
    expect(() => v.collection<Item>('late2', {
      computed: { virtTag: { fn: (r: Record<string, unknown>) => `T-${r.tag}`, mode: 'virtual', deps: ['tag'] } },
    } as never)).toThrow(/construction-only|virtual/)
  })

  it('ATTACHES a MATERIALIZED via()-spelled computed field, exactly as the sugar does', async () => {
    // The other half of "one rule": materialized computed fields DO late-attach
    // through the sugar key, so the via() spelling must attach too. Silently
    // dropping them was the same defect wearing its other face.
    const v = await vault()
    v.collection<Item>('late3')
    const c = v.collection<Item>('late3', { viaFields: MATERIALIZED } as never)
    await c.put('a', { id: 'a', tag: 'a' })
    expect((await c.get('a'))?.upper).toBe('A')
  })

  it('the reported shape: an MV-style pre-open no longer swallows the declaration', async () => {
    // pilot-1's path, minus the MV: something else opens the collection first,
    // then the owner declares its fields. Before the fix the field vanished and
    // the failure surfaced much later as a wrong aggregate.
    const v = await vault()
    v.collection<Item>('rows') // stand-in for the MV registry's pre-open
    expect(() => v.collection<Item>('rows', { viaFields: VIRTUAL } as never)).toThrow()
  })

  /**
   * The REPORTED shape end to end: a query-form MV registered over the same
   * collection its owner later declares fields on. MV registration runs its
   * `query()` callback to analyse it, which opens `items` first and makes the
   * owner's call the reconcile one.
   *
   * ⚠️ Asserted as "the wrong ANSWER cannot happen", not as "the declaration
   * throws", deliberately. Whether the MV pre-opens is incidental and may
   * change; what must never come back is the silent aggregate. So either the
   * declaration is refused, or the field attaches and #29's gate refuses the
   * groupBy — both are correct outcomes, and `[{ n: 2 }]` is the only failure.
   */
  it('the reported shape: a query-form MV can never yield the silent aggregate', async () => {
    const mv = withMaterializedView({
      name: 'qByTag',
      query: (db: never) => (db as unknown as { collection: (n: string) => { query: () => { groupBy: (f: string) => { aggregate: (s: unknown) => unknown } } } })
        .collection('items').query().groupBy('virtTag').aggregate({ n: count() }),
      rowKey: (row: Item) => String(row.virtTag),
      sources: ['items'],
      refresh: 'manual',
    } as never)
    const db = await createNoydb({
      store: memoryStore(), user: 'o', secret: 'issue-33-mv-preopen-acceptance',
      materializedViewStrategies: [mv], reduceStrategy: withReduce(),
    } as never)
    const v = await db.openVault('V')

    let refused = false
    let c: { put: (id: string, r: Item) => Promise<unknown>; query: () => never } | undefined
    try {
      c = v.collection<Item>('items', { viaFields: VIRTUAL } as never) as never
    } catch { refused = true }

    if (refused) return // the declaration was refused — loud, which is the point
    await c!.put('a', { id: 'a', tag: 'a' })
    await c!.put('b', { id: 'b', tag: 'b' })
    const q = c!.query() as unknown as { groupBy: (f: string) => { aggregate: (s: unknown) => { run: () => unknown } } }
    expect(() => q.groupBy('virtTag').aggregate({ n: count() }).run()).toThrow()
  })
})
