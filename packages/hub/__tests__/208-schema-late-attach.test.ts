/**
 * family#208 — `schema` (and `persistJsonSchema`) could not be late-attached
 * on the reconcile path, so a collection opened first by MV registration
 * ignored the consumer's schema and validated NOTHING.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, memoryStore, SchemaValidationError } from '../src/index.js'

const SECRET = 'correct horse battery staple river stone'

const Invoice = z.object({
  id: z.string().min(1),
  amount: z.number().positive(),
})
type Invoice = z.infer<typeof Invoice>

async function vault() {
  const db = await createNoydb({ store: memoryStore({ full: true }), user: 'owner', secret: SECRET, validateSecret: false })
  return { db, v: await db.openVault('acme') }
}

describe('family#208 — a schema declared on a reconcile', () => {
  it('CONTROL: on the FRESH path a schema rejects an invalid record', async () => {
    const { db, v } = await vault()
    const c = v.collection<Invoice>('bills', { schema: Invoice })
    await expect(c.put('b1', { id: 'b1', amount: -5 })).rejects.toThrow(SchemaValidationError)
    await db.close()
  })

  it('THE BUG: on a RECONCILE the schema must still reject an invalid record', async () => {
    const { db, v } = await vault()
    v.collection('bills')                                              // first, bare
    const c = v.collection<Invoice>('bills', { schema: Invoice })      // reconcile
    const outcome = await c.put('b1', { id: 'b1', amount: -5 }).then(() => 'accepted', (e: unknown) => e)
    console.log('  reconcile-path put of an INVALID record:', outcome === 'accepted' ? 'ACCEPTED (schema dropped)' : `rejected (${(outcome as Error).name})`)
    expect(outcome, 'the schema was silently dropped — the collection validates nothing').toBeInstanceOf(SchemaValidationError)
    await db.close()
  })

  it('a valid record still writes through the late-attached schema', async () => {
    // CONTROL: without this, the case above would also pass if a late schema
    // turned the collection into a blanket refusal.
    const { db, v } = await vault()
    v.collection('bills')
    const c = v.collection<Invoice>('bills', { schema: Invoice })
    await c.put('b1', { id: 'b1', amount: 10 })
    expect(await c.get('b1')).toEqual({ id: 'b1', amount: 10 })
    await db.close()
  })

  it('FIRST-WINS: a second, different schema does not re-contract the collection', async () => {
    // Matches every other `_apply*` door. ⭐ And it is right here rather than
    // merely consistent: the collection may already hold records admitted
    // under the first schema, so replacing it would re-contract stored data.
    const Loose = z.object({ id: z.string(), amount: z.number() }) // allows negatives
    const { db, v } = await vault()
    v.collection('bills')
    const first = v.collection<Invoice>('bills', { schema: Invoice })
    await first.put('ok', { id: 'ok', amount: 1 })
    const second = v.collection<Invoice>('bills', { schema: Loose as never })
    await expect(
      second.put('b2', { id: 'b2', amount: -5 }),
      'the second declaration replaced the schema the first records were admitted under',
    ).rejects.toThrow(SchemaValidationError)
    await db.close()
  })

  it('CONTROL: a bare reconcile after a schema declaration keeps validating', async () => {
    // The symmetric direction — acquiring the open collection with no options
    // must not clear the schema that is already attached.
    const { db, v } = await vault()
    v.collection<Invoice>('bills', { schema: Invoice })
    const bare = v.collection<Invoice>('bills')
    await expect(bare.put('b3', { id: 'b3', amount: -1 })).rejects.toThrow(SchemaValidationError)
    await db.close()
  })
})
