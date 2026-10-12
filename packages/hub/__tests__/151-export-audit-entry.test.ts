/**
 * family#151 — `vault.export()` records a tamper-evident audit entry.
 *
 * ⭐ WHY IT BELONGS IN HUB. Every format reaches the vault through one method,
 * `exportWith`. A per-package write is a duty each `as-*` author can forget
 * silently — and a ledger that records SOME plaintext exports and not others is
 * worse than one that records none, because the gap is invisible to the person
 * reading it.
 *
 * ⚠️ The entry is appended after the decrypt and BEFORE `encode`. The chunks
 * are plaintext by then; that is the disclosure, and a format whose `encode`
 * throws has not un-disclosed it. One case below asserts exactly that, because
 * it is the property a later "tidy-up" would move.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
// ⚠️ From `/as`, not the root barrel: `NoydbFormat` is the format port's type
// and the root barrel does not re-export it (caught by typecheck, which vitest
// does not run — `tsconfig.tests.json` is the other half).
import type { NoydbFormat } from '../src/port/as/index.js'
import { withFormats } from '../src/port/as/active.js'
import { withHistory } from '../src/with-commit/history/index.js'
// ⚠️ `withTeam()` is required by `grant()`, not by the feature under test —
// the plaintext-export capability is granted through the team surface.
import { withTeam } from '../src/with-party/team/index.js'

const SECRET = 'pw-export-audit-151'

const probe = (id: string, tier: 'plaintext' | 'bundle' = 'plaintext'): NoydbFormat<string> => ({
  id, extension: 'txt', mimeType: 'text/plain', tier,
  encode: (chunks) => chunks.map((c) => c.collection).join(','),
})

/**
 * A vault with a ledger AND an explicit plaintext-export grant.
 *
 * ⚠️ The grant is required, not boilerplate: a plaintext export is a granted
 * capability per format id, and without it `assertCanExport` refuses before any
 * record is read. That is also why the refusal case below is a real control —
 * it exercises the same gate with the grant withheld.
 */
async function vaultWithLedger(formats: readonly string[] = ['csvish', 'boom', 'nohistory']) {
  const store = memoryStore()
  const open = async (history: boolean) => await createNoydb({
    store, user: 'alice', secret: SECRET,
    formatsStrategy: withFormats(), teamStrategy: withTeam(),
    ...(history ? { historyStrategy: withHistory() } : {}),
  })
  // ⛔ GRANT, CLOSE, REOPEN. The export capability lives in the keyring FILE, so
  // a session that granted it still holds the pre-grant keyring — the export
  // would be refused and every case below would fail for a reason that has
  // nothing to do with the audit entry. Same shape as
  // `45-export-scope-narrows-read.test.ts`'s own seeding.
  const first = await open(true)
  const seeding = await first.openVault('acme')
  await seeding.collection<{ id: string }>('invoices').put('i1', { id: 'i1' })
  await first.grant('acme', {
    userId: 'alice', displayName: 'Alice', role: 'owner', secret: SECRET,
    exportCapability: { plaintext: [...formats] },
  })
  await first.close()

  const db = await open(true)
  return { db, vault: await db.openVault('acme'), store, open }
}

describe('family#151 — the export audit entry', () => {
  it('records a plaintext export, naming the tier and the format id', async () => {
    const { db, vault } = await vaultWithLedger()
    await vault.export(probe('csvish'))

    const entries = await vault.ledger().entries()
    const reasons = entries.map((e) => e.reason)
    expect(reasons, `no export entry: ${reasons.join(', ')}`).toContain('plaintext-export:csvish')
    await db.close()
  })

  it('distinguishes a BUNDLE export from a plaintext one', async () => {
    // `assertCanExport` already treats the two as different grants, so an audit
    // trail that collapsed them would be less informative than the gate.
    const { db, vault } = await vaultWithLedger()
    await vault.export(probe('pod', 'bundle'))
    const reasons = (await vault.ledger().entries()).map((e) => e.reason)
    expect(reasons).toContain('bundle-export:pod')
    expect(reasons).not.toContain('plaintext-export:pod')
    await db.close()
  })

  it('⭐ records the export even when the format\'s encode THROWS', async () => {
    // The disclosure already happened: the chunks were decrypted before
    // `encode` ran. An entry written only on success would under-record exactly
    // the case a reader cares about most.
    const { db, vault } = await vaultWithLedger()
    const exploding: NoydbFormat<string> = {
      ...probe('boom'),
      encode: () => { throw new Error('encode failed') },
    }
    await expect(vault.export(exploding)).rejects.toThrow(/encode failed/)
    const reasons = (await vault.ledger().entries()).map((e) => e.reason)
    expect(reasons, 'a decrypt happened and nothing recorded it').toContain('plaintext-export:boom')
    await db.close()
  })

  it('⛔ writes NOTHING when the export is refused by the capability gate', async () => {
    // The control in the other direction. `assertCanExport` runs before a
    // single record is read, so there is no disclosure to record — and an entry
    // here would report an export that never happened.
    const db = await createNoydb({
      store: memoryStore(), user: 'alice', secret: SECRET,
      formatsStrategy: withFormats(), historyStrategy: withHistory(),
    })
    const vault = await db.openVault('acme')
    await vault.collection<{ id: string }>('invoices').put('i1', { id: 'i1' })
    const before = (await vault.ledger().entries()).length

    // No export capability was granted for this format id.
    await expect(vault.export(probe('ungranted'))).rejects.toThrow()
    const after = await vault.ledger().entries()
    expect(after.length, 'a refused export was logged as an export').toBe(before)
    expect(after.map((e) => e.reason)).not.toContain('plaintext-export:ungranted')
    await db.close()
  })

  it('is a NO-OP without a history strategy — no phantom _ledger DEK', async () => {
    // ⛔ `_getLedgerOrNull()`, not a mint. Creating the audit trail as a side
    // effect of a caller's first export would opt them into a subsystem they
    // never asked for, and the DEK would outlive the export.
    // Seeded WITH history so the grant lands, then reopened WITHOUT it — so the
    // only difference from the cases above is the absent ledger.
    const seeded = await vaultWithLedger()
    await seeded.db.close()
    const db = await seeded.open(false)
    const vault = await db.openVault('acme')
    expect(await vault.export(probe('nohistory'))).toBe('invoices')
    await db.close()
  })
})
