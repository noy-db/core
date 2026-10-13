/**
 * family#194 — a reconcile `vault.collection()` silently dropped the
 * declaration-only options. Ruled TIERED, following core#33: attach what can
 * attach, refuse only what genuinely cannot.
 *
 * ⛔ WHY NOT A BLANKET REFUSAL, which was the first attempt: core#33's own test
 * states the shape — "a virtual entry is refused, a materialized one ATTACHES"
 * — and the reason sits in the same header: "MV registration opens its source
 * collection first, which makes the consumer's own declaration the reconcile
 * call." A consumer declaring on a collection that backs a materialized view is
 * FORCED to be second. Refusing them breaks correct code, and three in-tree
 * tests (core#33's among them) failed when I tried it.
 *
 * ⚠️ Cache-state dependent, by consequence of family#192: clearing the
 * collection cache (`_enableSync`, `_reloadKeyringAfterSync`) sends the next
 * acquisition down the FRESH branch, where everything is honoured and nothing
 * refuses.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, withArchive, ValidationError } from '../src/index.js'

const SECRET = 'correct horse battery staple river stone'

async function vault() {
  const db = await createNoydb({ store: memoryStore({ full: true }), user: 'owner', secret: SECRET, validateSecret: false })
  return { db, v: await db.openVault('acme') }
}

describe('family#194 — declaration-only options on a reconcile', () => {
  it('⛔ schemaUpdate is REFUSED — its gate is built once, at construction', async () => {
    const { db, v } = await vault()
    v.collection('bills')
    try {
      v.collection('bills', { schemaUpdate: ['widen'] as never })
      throw new Error('a dropped schemaUpdate was accepted in silence')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const m = (err as Error).message
      expect(m, 'must name the option').toContain('schemaUpdate')
      expect(m, 'must name the collection').toContain('bills')
      expect(m, 'must say WHY it cannot attach').toMatch(/built once/i)
      expect(m, 'must give a way out').toMatch(/first|no options/i)
    }
    await db.close()
  })

  it('⭐ archive ATTACHES on a reconcile — a policy declared second is honoured', async () => {
    // ⚠️ My first version of this asserted `x === null || x !== undefined`,
    // which is true for every input — a vacuous green. The observable
    // consequence is that `vault.archive()` runs the policy, since it walks
    // `collectionsWithPolicy()`; that is what is asserted now.
    const cold = memoryStore({ full: true })
    const db = await createNoydb({
      store: memoryStore({ full: true }), user: 'owner', secret: SECRET,
      validateSecret: false, archiveStrategy: withArchive({ store: cold }),
    })
    const v = await db.openVault('books')

    interface Invoice extends Record<string, unknown> { id: string; year: number }
    v.collection<Invoice>('invoices')                                   // first: BARE, so this is a reconcile
    const inv = v.collection<Invoice>('invoices', {                     // second: the policy
      archive: { archiveWhen: (r) => (r as Invoice).year <= 2022 },
    })

    await inv.put('old', { id: 'old', year: 2020 })
    await inv.put('new', { id: 'new', year: 2025 })

    const res = await v.archive()
    expect(res.archived, 'the policy declared on the reconcile call was dropped').toBe(1)
    expect(await inv.get('old'), 'the eligible record was not archived').toBeNull()
    expect((await inv.get('new'))?.year, 'an ineligible record was archived').toBe(2025)
    await db.close()
  })

  it('CONTROL: schema on a reconcile is NOT refused — the MV pre-creation path', async () => {
    // ⛔ THIS IS THE CASE THE BLANKET REFUSAL BROKE. A materialized view opens
    // its source collection first, so the consumer's own `{ schema }` lands on
    // the reconcile path through no choice of theirs. It must not throw.
    // (Honouring it is family#194's follow-up row — `schema` needs the same
    // MV-pre-creation door `computed` and `moneyFields` already have.)
    const { db, v } = await vault()
    v.collection('items')
    expect(() => v.collection('items', { schema: { '~standard': { version: 1, vendor: 'x', validate: (x: unknown) => ({ value: x }) } } as never }))
      .not.toThrow()
    await db.close()
  })

  it('CONTROL: a via-family option on a reconcile still attaches', async () => {
    const { db, v } = await vault()
    v.collection('docs')
    expect(() => v.collection('docs', { blobFields: { scan: {} } as never })).not.toThrow()
    await db.close()
  })
})
