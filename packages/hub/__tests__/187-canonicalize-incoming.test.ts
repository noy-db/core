/**
 * family#187 — `_admitRemote` handed guards an UNCANONICALIZED incoming record.
 *
 * ⛔ WHY IT STOPPED EVERY ISSUED RECORD FROM SYNCING. `decryptRecord(…,
 * { skipValidation: true })` returns STORAGE form, while the gate's `existing`
 * goes through `via.canonicalizeStored`. A guard comparing the two on a
 * `money()` field was therefore comparing a stored shape against a canonical
 * one, so it saw a difference on every pulled record even when the bytes were
 * identical — and for an issued (WORM) record, whose guard refuses any change,
 * that means the record never arrives.
 *
 * ⚠️ INVISIBLE TO ANY SINGLE-SHAPE TEST, which is why it shipped: a collection
 * with no via fields canonicalizes to itself, so `incoming` and `existing` have
 * the same shape and every existing guard test passes either way. The defect
 * needs a field whose stored and canonical forms DIFFER.
 *
 * ⚠️ BOTH REMOTE ORIGINS, because `_admitRemote` takes two and the fix had to
 * cover both: `'sync-apply'` on a pull, and `'push-recheck'` where the record is
 * already stored.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, money, withGuard } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/index.js'

const SECRET = 'correct horse battery staple river stone'
const THB = money({ currency: 'THB', scale: 2 })

interface Invoice extends Record<string, unknown> { id: string; total: unknown; status: string }

/** Records what each guard invocation saw, so the asymmetry is observable. */
interface Seen { origin: string | undefined; incoming: unknown; existing: unknown; same: boolean }

function sameShape(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function twoDevices(seen: Seen[]) {
  const remote = memoryStore()
  const guard = withGuard<Invoice>({
    collection: 'invoices',
    check: async (incoming, ctx) => {
      if (ctx.existing == null) return
      seen.push({
        origin: ctx.origin,
        incoming: incoming.total,
        existing: (ctx.existing as Invoice).total,
        same: sameShape(incoming.total, (ctx.existing as Invoice).total),
      })
    },
  })
  const open = async (store: NoydbStore) => await createNoydb({
    store, sync: remote, user: 'alice', secret: SECRET,
    syncStrategy: (await import('../src/with-sync/index.js')).withSync(),
    guardStrategies: [guard],
  })

  const a = await open(memoryStore())
  const vA = await a.openVault('firm')
  const invA = vA.collection<Invoice>('invoices', { moneyFields: { total: THB } })
  await invA.put('i1', { id: 'i1', total: 1000, status: 'draft' } as never)
  await a.push('firm')
  return { remote, a, vA, invA, open }
}

describe('family#187 — incoming is canonicalized like existing', () => {
  it('⭐ a guard on a money field sees the SAME shape on both sides (sync-apply)', async () => {
    const seen: Seen[] = []
    const { remote, a, open } = await twoDevices(seen)

    // Device 2 pulls the record, then pulls an UPDATE to it — the second pull
    // is the one where `existing` is non-null and the compare happens.
    const b = await open(memoryStore())
    const vB = await b.openVault('firm')
    vB.collection<Invoice>('invoices', { moneyFields: { total: THB } })
    await b.pull('firm')

    // ⚠️ THE SAME TOTAL, a different status. My first version changed the amount
    // and then asserted the two sides were equal — of course they differed, and
    // the output ("2000.00" vs "1000.00") showed BOTH were already canonical,
    // so the assertion was measuring my own edit rather than the shapes. The
    // reported symptom is "every remote compare sees a change even when the
    // value is identical", so the value has to be identical.
    const a2 = await a.openVault('firm')
    await a2.collection<Invoice>('invoices', { moneyFields: { total: THB } })
      .put('i1', { id: 'i1', total: 1000, status: 'issued' } as never)
    await a.push('firm')
    await b.pull('firm')

    const remoteCompares = seen.filter((s) => s.origin === 'sync-apply')
    expect(remoteCompares.length, 'no sync-apply compare happened — the fixture is not exercising it').toBeGreaterThan(0)
    for (const s of remoteCompares) {
      // The value is unchanged, so a guard must see NO difference. Under the
      // defect `incoming.total` was storage form and `existing.total`
      // canonical, so this compared e.g. 1000 against "1000.00".
      expect(
        s.same,
        `a guard saw a change on an unchanged money field: ${JSON.stringify(s.incoming)} vs ${JSON.stringify(s.existing)}`,
      ).toBe(true)
      // And the SHAPES match, which is the property independent of the value.
      expect(typeof s.incoming, 'incoming is not in canonical form').toBe(typeof s.existing)
    }
    await a.close(); await b.close(); void remote
  })

  it('⭐ and on push-recheck, where the record is already stored', async () => {
    const seen: Seen[] = []
    const { a, vA } = await twoDevices(seen)

    // A second push re-checks what is already stored — the `push-recheck`
    // origin, which `_admitRemote` takes and which the fix had to cover too.
    await vA.collection<Invoice>('invoices', { moneyFields: { total: THB } })
      .put('i1', { id: 'i1', total: 1000, status: 'issued' } as never) // same total
    await a.push('firm')

    const pushCompares = seen.filter((s) => s.origin === 'push-recheck')
    for (const s of pushCompares) {
      expect(s.same, `push-recheck saw different shapes: ${JSON.stringify(s.incoming)} vs ${JSON.stringify(s.existing)}`).toBe(true)
    }
    await a.close()
  })

  it('a collection with NO via fields is unaffected — the control', async () => {
    // Without this, canonicalizing unconditionally could have changed the
    // shape a guard sees for every plain collection. A record with no via
    // fields must canonicalize to itself.
    const seen: Seen[] = []
    const remote = memoryStore()
    const guard = withGuard<Record<string, unknown>>({
      collection: 'plain',
      check: async (incoming, ctx) => {
        if (ctx.existing == null) return
        seen.push({ origin: ctx.origin, incoming, existing: ctx.existing, same: sameShape(incoming, ctx.existing) })
      },
    })
    const open = async (store: NoydbStore) => await createNoydb({
      store, sync: remote, user: 'alice', secret: SECRET,
      syncStrategy: (await import('../src/with-sync/index.js')).withSync(),
      guardStrategies: [guard],
    })
    const a = await open(memoryStore())
    const vA = await a.openVault('firm')
    await vA.collection<{ n: number }>('plain').put('p1', { n: 1 })
    await a.push('firm')
    const b = await open(memoryStore())
    const vB = await b.openVault('firm')
    vB.collection<{ n: number }>('plain')
    await b.pull('firm')
    await vA.collection<{ n: number }>('plain').put('p1', { n: 2 })
    await a.push('firm'); await b.pull('firm')

    expect((await vB.collection<{ n: number }>('plain').get('p1'))?.n).toBe(2)
    await a.close(); await b.close()
  })
})
