/**
 * family#188 — `transitionGuard`'s `initial` set rejected every PULLED record
 * that was already past its initial state.
 *
 * ⛔ A FRESH DEVICE COULD NEVER RECEIVE AN ISSUED INVOICE. The insert branch
 * fired on `ctx.existing === null` with no reference to `ctx.origin`, and a
 * record arriving on a device that has never seen it has no local prior — so
 * `initial: ['draft']` refused it with `IllegalTransitionError('(none)' →
 * 'issued')`. For an issued (WORM) record that is permanent: nothing will ever
 * re-send it in a state this device would accept.
 *
 * ⭐ RULED: `initial` is about AUTHORSHIP, not about absence. It says "this
 * application may only CREATE a record in these states" — a pulled record was
 * authored elsewhere and already passed that gate on the device that wrote it.
 * So `initial` constrains LOCAL creates only, while the ARC check on updates
 * stays on every origin.
 *
 * The last two cases are the controls, and without them this fix is a hole:
 * a local create in a forbidden state must STILL be refused, and a remote peer
 * must STILL not be able to drive a record along an undeclared edge.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, transitionGuard, IllegalTransitionError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore } from '../src/index.js'

const SECRET = 'correct horse battery staple river stone'

interface Invoice extends Record<string, unknown> { id: string; status: string }

/** draft → issued → paid, and nothing may be CREATED other than as a draft. */
const guard = transitionGuard<Invoice>({
  collection: 'invoices',
  field: 'status',
  initial: ['draft'],
  transitions: { draft: ['issued'], issued: ['paid'], paid: [] },
})

function open(store: NoydbStore, remote: NoydbStore, guarded = true) {
  return createNoydb({
    store, sync: remote, user: 'alice', secret: SECRET,
    syncStrategy: withSync(),
    ...(guarded ? { guardStrategies: [guard] } : {}),
  })
}

/** Device A publishes an invoice that has already advanced to `issued`. */
async function anIssuedInvoiceOnTheWire() {
  const remote = memoryStore()
  const a = await open(memoryStore(), remote)
  const vA = await a.openVault('firm')
  const inv = vA.collection<Invoice>('invoices')
  await inv.put('i1', { id: 'i1', status: 'draft' })
  await inv.put('i1', { id: 'i1', status: 'issued' }) // a legal local arc
  await a.push('firm')
  return { remote, a, vA }
}

describe('family#188 — `initial` constrains local creates only', () => {
  it('⭐ a FRESH device accepts a pulled invoice already at `issued` (sync-apply)', async () => {
    const { remote, a } = await anIssuedInvoiceOnTheWire()

    const b = await open(memoryStore(), remote)
    const vB = await b.openVault('firm')
    vB.collection<Invoice>('invoices')
    const pull = await b.pull('firm')

    expect(
      pull.rejected ?? [],
      'the pulled invoice was refused — `initial` is being applied to a remote record',
    ).toEqual([])
    expect(
      (await vB.collection<Invoice>('invoices').get('i1'))?.status,
      'the invoice never arrived on the fresh device',
    ).toBe('issued')

    await a.close(); await b.close()
  })

  it('⭐ and on push-recheck, where the record is already stored', async () => {
    // `_admitRemote`'s other origin, and it needs an exact fixture.
    //
    // ⛔ MY FIRST VERSION OF THIS CASE PASSED WITHOUT THE FIX — the mutation
    // check caught it. It pushed a record at `_v === 2`, but core#108's
    // degeneracy is `selfIsPrior = origin === 'push-recheck' && _v === 1`:
    // only a FIRST-EVER version reports `existing: null` on a re-push. At
    // `_v === 2` the stored record is the prior, so it took the UPDATE branch
    // and `initial` was never consulted at all.
    //
    // So the record must be at `_v === 1` AND already past `draft` — which a
    // guarded device cannot author, as the local-create control below proves.
    // It is created by an UNGUARDED instance and then pushed from a guarded one
    // over the SAME store, which is the real shape anyway: guards added to an
    // application that already holds data.
    const remote = memoryStore()
    const store = memoryStore()

    const seeder = await open(store, remote, false) // no guards
    const vSeed = await seeder.openVault('firm')
    await vSeed.collection<Invoice>('invoices').put('i2', { id: 'i2', status: 'issued' })
    await seeder.close()

    const a = await open(store, remote) // guards on, same store
    const vA = await a.openVault('firm')
    vA.collection<Invoice>('invoices')
    const pushed = await a.push('firm')

    expect(
      pushed.rejected?.map((r) => `${r.collection}/${r.id}`) ?? [],
      'push-recheck refused a first-version record already past `draft`',
    ).not.toContain('invoices/i2')
    expect((await vA.collection<Invoice>('invoices').get('i2'))?.status).toBe('issued')
    await a.close()
  })

  it('⛔ CONTROL: a LOCAL create in a forbidden state is still refused', async () => {
    // Without this, exempting remotes could have been written as "exempt
    // everything", disabling the gate entirely and silently.
    const remote = memoryStore()
    const a = await open(memoryStore(), remote)
    const vA = await a.openVault('firm')
    await expect(
      vA.collection<Invoice>('invoices').put('i3', { id: 'i3', status: 'issued' }),
    ).rejects.toThrow(IllegalTransitionError)
    await a.close()
  })

  it('⛔ CONTROL: a remote peer still cannot drive a record along an undeclared edge', async () => {
    // The arc check must stay on EVERY origin. An UNGUARDED peer authors
    // `paid → draft`, which no declared edge allows; the guarded device must
    // refuse it at admission rather than waving every remote through.
    const remote = memoryStore()
    const guarded = await open(memoryStore(), remote)
    const vG = await guarded.openVault('firm')
    const invG = vG.collection<Invoice>('invoices')
    await invG.put('i4', { id: 'i4', status: 'draft' })
    await invG.put('i4', { id: 'i4', status: 'issued' })
    await guarded.push('firm')

    const rogue = await open(memoryStore(), remote, false) // no guards
    const vR = await rogue.openVault('firm')
    vR.collection<Invoice>('invoices')
    await rogue.pull('firm')
    await vR.collection<Invoice>('invoices').put('i4', { id: 'i4', status: 'draft' })
    await rogue.push('firm')

    const pull = await guarded.pull('firm')
    expect(
      pull.rejected?.map((r) => `${r.collection}/${r.id}`) ?? [],
      'a remote peer drove the record backwards along an edge no transition declares',
    ).toContain('invoices/i4')
    expect(
      (await vG.collection<Invoice>('invoices').get('i4'))?.status,
      'the local copy was overwritten by a refused remote update',
    ).toBe('issued')

    await guarded.close(); await rogue.close()
  })
})
