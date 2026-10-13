/**
 * family#201 — `frozenFields` refused an UNCHANGED re-put of a record holding a
 * nested money field.
 *
 * ⛔ THE SKEW. A read with a locale adds `<path>Formatted` / `<path>Number`
 * virtuals (`via/money/normalize.ts`). `canonicalizeIncomingMoney` decodes with
 * `'raw'`, which stops it ADDING virtuals, but `decodeMoneyFields`
 * shallow-clones — so virtuals the caller carried in survived ingest. The gate's
 * `existing` goes through `canonicalizeStoredMoney`, which carries none, so
 * `frozenFields` deep-compared `{ amount, sku, amountFormatted, amountNumber }`
 * against `{ amount, sku }` and threw `FieldFrozenError` for a field nobody
 * touched. The commonest write there is — `put(id, await get(id, { locale }))`
 * — was therefore refused outright on an issued record.
 *
 * ⭐ This is `canonicalizeStoredMoney`'s own rule applied to the other side: the
 * gate boundaries carry no locale, and letting a virtual through "would
 * re-create a two-read-paths skew inside comparisons". Same class as
 * family#187 (storage form vs canonical form at a compare) and family#202
 * (compared before a derivation ran).
 *
 * ⚠️ NESTED ONLY, which is why it shipped: a TOP-LEVEL money path compares
 * scalar-to-scalar, so the extra sibling keys never enter the comparison. The
 * control below pins that.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, money, withGuard, FieldFrozenError } from '../src/index.js'

const SECRET = 'correct horse battery staple river stone'
const THB = money({ currency: 'THB', scale: 2 })

interface Bill extends Record<string, unknown> {
  id: string
  line?: { amount: unknown; sku: string }
  amount?: unknown
  status: string
}

async function open(fields: Record<string, ReturnType<typeof money>>, frozen: string[]) {
  const guard = withGuard<Bill>({
    collection: 'bills',
    frozenFields: { when: (r) => r.status === 'issued', fields: frozen as never },
  })
  const db = await createNoydb({
    store: memoryStore({ full: true }), user: 'o', secret: SECRET,
    validateSecret: false, guardStrategies: [guard],
  })
  const v = await db.openVault('acme')
  return { db, bills: v.collection<Bill>('bills', { moneyFields: fields }) }
}

describe('family#201 — read virtuals are stripped on ingest', () => {
  it('⭐ an unchanged re-put of a localized read is ACCEPTED (nested money)', async () => {
    const { db, bills } = await open({ 'line.amount': THB }, ['line'])
    await bills.put('b1', { id: 'b1', line: { amount: 1000, sku: 'X' }, status: 'issued' })

    const read = await bills.get('b1', { locale: 'th-TH' })
    expect(Object.keys(read!.line as object), 'the read did not add virtuals — fixture is wrong')
      .toContain('amountFormatted')

    await expect(
      bills.put('b1', read as Bill),
      'an unchanged re-put of a localized read was refused',
    ).resolves.not.toThrow()
    await db.close()
  })

  it('⛔ a REAL change to the frozen field is still refused', async () => {
    // Without this, stripping could have been written so broadly that the
    // comparison stopped seeing anything at all.
    const { db, bills } = await open({ 'line.amount': THB }, ['line'])
    await bills.put('b1', { id: 'b1', line: { amount: 1000, sku: 'X' }, status: 'issued' })
    const read = await bills.get('b1', { locale: 'th-TH' })
    await expect(
      bills.put('b1', { ...read!, line: { ...(read!.line as object), amount: 2000 } } as Bill),
      'a genuine change to a frozen money field was accepted',
    ).rejects.toThrow(FieldFrozenError)
    await db.close()
  })

  it('⛔ a real change to a SIBLING of the frozen money path is still refused', async () => {
    const { db, bills } = await open({ 'line.amount': THB }, ['line'])
    await bills.put('b1', { id: 'b1', line: { amount: 1000, sku: 'X' }, status: 'issued' })
    const read = await bills.get('b1', { locale: 'th-TH' })
    await expect(
      bills.put('b1', { ...read!, line: { ...(read!.line as object), sku: 'Y' } } as Bill),
    ).rejects.toThrow(FieldFrozenError)
    await db.close()
  })

  it('⭐ virtuals are no longer PERSISTED — a round-trip leaves raw storage clean', async () => {
    // Measured before the fix: a round-tripped read stored `amountFormatted`
    // and it came back out of `locale: 'raw'`, where it goes stale and carries
    // one client's locale forever.
    const { db, bills } = await open({ 'line.amount': THB }, ['line'])
    await bills.put('b1', { id: 'b1', line: { amount: 1000, sku: 'X' }, status: 'draft' })
    await bills.put('b1', (await bills.get('b1', { locale: 'th-TH' })) as Bill)

    const raw = await bills.get('b1', { locale: 'raw' })
    expect(Object.keys(raw!.line as object).sort(), 'a locale-formatted virtual was persisted')
      .toEqual(['amount', 'sku'])
    await db.close()
  })

  it('CONTROL: a TOP-LEVEL money path was never affected', async () => {
    // It compares scalar-to-scalar, so the sibling virtuals never entered the
    // comparison — this passes with and without the fix, and says so.
    const { db, bills } = await open({ amount: THB }, ['amount'])
    await bills.put('b1', { id: 'b1', amount: 1000, status: 'issued' })
    await expect(
      bills.put('b1', (await bills.get('b1', { locale: 'th-TH' })) as Bill),
    ).resolves.not.toThrow()
    await db.close()
  })
})
