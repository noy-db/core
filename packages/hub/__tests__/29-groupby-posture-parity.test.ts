/**
 * #29 — every query verb that addresses a field BY NAME refuses a
 * `queryable: 'none'` field. Written as a PARITY table, not four separate
 * cases, because the defect was never "groupBy is wrong" — it was that the
 * posture gate is copy-pasted per verb, so a verb can be added or refactored
 * without one and nothing notices.
 *
 * ⛔ WHAT IT COST. `where`, `orderBy` and `distinct` each carried the line;
 * `groupBy` did not. A virtual computed field (`mode: 'virtual'`, posture
 * `queryable: 'none'` — it exists only on the presented read path, never in
 * the stored record the reducer walks) grouped to `undefined` for every row.
 * Two distinct keys folded into one bucket of 2, with the key absent from the
 * row entirely, no throw anywhere. `vLannaAi/noy-db#1269` fixed the union-map
 * half of this and left the query-form half standing; pilot-1 measured it on
 * published `0.8.0` and filed noy-db/core#29.
 *
 * ⭐ The asymmetry is the whole point: `where()` refuses to build a predicate
 * it cannot answer, and `groupBy()` answered anyway. A consumer can catch a
 * throw. Nothing downstream can detect a key that silently became `undefined`
 * — the aggregate is well-formed and the row count is plausible.
 *
 * ⚠️ ADDING A VERB: add it to VERBS. The registration guard
 * (`validateMvGroupByAtRegistration`) reads the DECLARATIVE `spec.groupBy`
 * only, so a query-form MV groups inside its callback where that guard cannot
 * see it. Gating in the builder is what covers both forms at once — do not
 * move this check up into the MV registry.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, FieldNotQueryableError } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import type { Collection } from '../src/kernel/collection.js'
import { count, withReduce } from '../src/with-lookup/reduce/index.js'

interface Item extends Record<string, unknown> { id: string; tag: string }

/** Each verb, applied to one named field. */
const VERBS: readonly { name: string; run: (c: Collection<Item>, field: string) => unknown }[] = [
  { name: 'where', run: (c, f) => c.query().where(f as never, '==', 'x').toArray() },
  { name: 'orderBy', run: (c, f) => c.query().orderBy(f as never).toArray() },
  { name: 'distinct', run: (c, f) => c.query().distinct(f as never) },
  { name: 'groupBy', run: (c, f) => c.query().groupBy(f as never).aggregate({ n: count() }).run() },
]

async function items(): Promise<Collection<Item>> {
  const db = await createNoydb({
    store: memoryStore(), user: 'o', secret: 'issue-29-groupby-posture-parity',
    reduceStrategy: withReduce(),
  })
  const vault = await db.openVault('V')
  const c = vault.collection<Item>('items', {
    computed: { virtTag: { fn: (r: Record<string, unknown>) => `T-${r.tag}`, mode: 'virtual', deps: ['tag'] } },
  } as never)
  await c.put('a', { id: 'a', tag: 'a' })
  await c.put('b', { id: 'b', tag: 'b' })
  return c
}

describe('#29 — posture gate parity across query verbs', () => {
  it('the field really is virtual and really does present — the premise', async () => {
    // Without this, every refusal below could pass against a field that simply
    // does not exist, and the table would prove nothing about postures.
    const c = await items()
    expect((await c.get('a'))?.virtTag).toBe('T-a')
    expect(Object.keys((await c.query().where('id', '==', 'a').toArray())[0] ?? {})).toContain('virtTag')
  })

  for (const verb of VERBS) {
    it(`${verb.name}() refuses a queryable:'none' field`, async () => {
      const c = await items()
      await expect(async () => await verb.run(c, 'virtTag')).rejects.toThrow(FieldNotQueryableError)
    })

    it(`${verb.name}() still works on an ordinary field — the control`, async () => {
      // Paired with the refusal above so "it threw" cannot be satisfied by a
      // verb that refuses everything, or by one that is simply broken.
      const c = await items()
      await expect(async () => await verb.run(c, 'tag')).not.toThrow()
    })
  }

  it('the specific wrong answer #29 reported is gone', async () => {
    // The regression in the shape the consumer measured: before the gate this
    // returned [{ n: 2 }] — both records in one bucket, key absent.
    const c = await items()
    await expect(
      async () => await c.query().groupBy('virtTag' as never).aggregate({ n: count() }).run(),
    ).rejects.toThrow(/virtTag/)
  })
})
