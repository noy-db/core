/**
 * family#202 — AN INTEGRITY BYPASS: a computed `dateField` dodged the
 * closed-period seal.
 *
 * ⛔ The `beforePut` gate bus ran BEFORE computed scalar fields were evaluated,
 * so a computed `dateField` was still `undefined` when the closed-period guard
 * judged the record. `couldGovern` reads an absent date as OUTSIDE every period
 * (`with-audit/periods/vault-facade.ts:660`, #1455's deliberate rule — a record
 * with no date genuinely belongs to no period), so the guard did not fire at
 * all and the write landed inside a sealed period.
 *
 * ⭐ Fixed by moving the GATE DOWN, past the computed block — not by moving
 * computed up. Moving computed up would put it ahead of `via.enforceWrite`,
 * whose own comment states it runs before anything derives, and would make a
 * `ComputedFieldError` outrank a gate refusal.
 *
 * ⛔ AND NOT BY DISPATCHING TWICE. The gate's amendment branch COLLECTS without
 * throwing, so a second dispatch double-collects; any handler with a side
 * effect would also fire twice. The one-dispatch-after-computed shape is the
 * only one that is both correct and cheap.
 *
 * ⚠️ Unaffected, deliberately untested here: remote admission
 * (`_admitRemote`, `collection.ts:1735` and the delete gate at `:4086`) builds
 * its event from a DECRYPTED STORED record, which already carries its persisted
 * computed fields. There was never a gap on that path.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, PeriodClosedError } from '../src/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'

interface Bill extends Record<string, unknown> {
  id: string
  /** The raw input. `month` is DERIVED from it and is the period's dateField. */
  issuedOn: string
  amount: number
  month?: string
}

/** `month` is computed from `issuedOn` — the whole point: it is absent on input. */
const COMPUTED = { month: (r: Record<string, unknown>) => String(r.issuedOn).slice(0, 10) }

async function vaultWithClosedQ1(opts: { computed: boolean }) {
  const db = await createNoydb({
    store: memoryStore({ full: true }),
    user: 'owner',
    encrypt: false,
    periodsStrategy: withPeriods(),
  })
  const vault = await db.openVault('acme')
  const bills = opts.computed
    ? vault.collection<Bill>('bills', { computed: COMPUTED })
    : vault.collection<Bill>('bills')
  // Seal everything up to 2026-03-31, judged on `month`.
  await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'month' })
  return { db, vault, bills }
}

describe('family#202 — the gate judges the record AFTER computed fields apply', () => {
  it('⛔ a COMPUTED dateField inside a sealed period is REFUSED', async () => {
    const { db, bills } = await vaultWithClosedQ1({ computed: true })
    // `month` is absent on input and computes to 2026-02-14 — inside Q1.
    await expect(
      bills.put('b1', { id: 'b1', issuedOn: '2026-02-14', amount: 100 }),
      'a computed dateField dodged the closed-period seal',
    ).rejects.toThrow(PeriodClosedError)
    await db.close()
  })

  it('CONTROL: an update of a record ALREADY sealed was never vulnerable', async () => {
    // ⭐ This passes with AND without the fix, and that is the finding: the
    // guard checks `record[dateField]` on the EXISTING prior as well as the
    // incoming record (periods.ts:770), and the prior carries its persisted
    // `month`. So the bypass is CREATE-ONLY — narrower than the issue said.
    // Kept as a control: it proves the existing-side check still fires.
    const db = await createNoydb({
      store: memoryStore({ full: true }), user: 'owner', encrypt: false,
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('acme')
    const bills = vault.collection<Bill>('bills', { computed: COMPUTED })
    await bills.put('b1', { id: 'b1', issuedOn: '2026-02-14', amount: 100 })
    await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'month' })

    await expect(
      bills.put('b1', { id: 'b1', issuedOn: '2026-02-14', amount: 999 }),
      'a sealed record was editable through a computed dateField',
    ).rejects.toThrow(PeriodClosedError)
    expect((await bills.get('b1'))?.amount, 'the sealed record was mutated').toBe(100)
    await db.close()
  })

  it('⛔ an update that MOVES a record INTO the sealed period is REFUSED', async () => {
    // The genuine update-path bypass, which the issue did not name. The
    // existing record sits OUTSIDE the period (so the prior-side check stays
    // quiet) and the re-put's COMPUTED date lands INSIDE it. Before the fix the
    // gate saw an absent date on the incoming side and an out-of-period date on
    // the existing side — neither fired, and the record was moved into sealed
    // history.
    const db = await createNoydb({
      store: memoryStore({ full: true }), user: 'owner', encrypt: false,
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('acme')
    const bills = vault.collection<Bill>('bills', { computed: COMPUTED })
    await bills.put('b4', { id: 'b4', issuedOn: '2026-06-01', amount: 100 }) // outside
    await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'month' })

    await expect(
      bills.put('b4', { id: 'b4', issuedOn: '2026-02-14', amount: 100 }), // into Q1
      'a record was back-dated into a sealed period through a computed field',
    ).rejects.toThrow(PeriodClosedError)
    expect((await bills.get('b4'))?.month, 'the record was moved into the seal').toBe('2026-06-01')
    await db.close()
  })

  it('CONTROL: a NON-computed dateField is still refused — the gate still works', async () => {
    // Without this, moving the gate could have disabled it entirely and the
    // case above would still pass for the wrong reason.
    const { db, bills } = await vaultWithClosedQ1({ computed: false })
    await expect(
      bills.put('b2', { id: 'b2', issuedOn: '2026-02-14', amount: 100, month: '2026-02-14' }),
    ).rejects.toThrow(PeriodClosedError)
    await db.close()
  })

  it('CONTROL: a computed date OUTSIDE the period still writes', async () => {
    // The seal must not become a blanket refusal for computed collections.
    const { db, bills } = await vaultWithClosedQ1({ computed: true })
    await bills.put('b3', { id: 'b3', issuedOn: '2026-06-01', amount: 100 })
    expect((await bills.get('b3'))?.amount).toBe(100)
    expect((await bills.get('b3'))?.month, 'the computed field was not persisted').toBe('2026-06-01')
    await db.close()
  })
})
