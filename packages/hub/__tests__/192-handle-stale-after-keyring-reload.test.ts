/**
 * family#192 — a collection handle held across a pull that reloads this user's
 * keyring went STALE, and stayed stale.
 *
 * ## The mechanism, in two parts
 *
 * `_reloadKeyringAfterSync` (core#82) rebuilt the DEK resolver and then called
 * `collectionCache.clear()`. Two separate failures came out of that one line.
 *
 * 1. **The handle the caller holds IS an object in that map.** Dropping the map
 *    fixes the next `vault.collection()` and leaves the held handle answering
 *    from its own pre-pull cache. That is exactly core#122's finding — which
 *    was fixed on the RESTORE path (`clearCollectionCache` invalidates each
 *    instance first) and never applied here.
 *
 * 2. ⛔ **And core#122's remedy alone is not enough on this path.**
 *    `_invalidateSyncApplied` finds its target through
 *    `collectionCache.get(collection)`, so clearing the map ORPHANS a held
 *    handle from per-record invalidation for the rest of its life. Measured:
 *    with invalidate-then-clear the handle reads correctly once and is stale
 *    again on the very next pull, with no keyring change involved and nothing
 *    left to re-register it.
 *
 * ⭐ So the fix invalidates instances IN PLACE and keeps them registered, and
 * `Collection.getDEK` became an indirection through the vault's CURRENT
 * resolver — the thing that actually went stale was the key resolver, which is
 * assigned once into a `readonly` field while the reload REPLACES the vault's.
 *
 * ## Why the existing coverage could not see it
 *
 * `hot-replica.test.ts`'s core#82(3) case asserts the same reload works — and
 * reads through a FRESH `vault.collection()` call every time. The whole defect
 * lives in the handle you were already holding, which is the natural shape of
 * the code a caller writes.
 *
 * ⚠️ ROUND 2 IS THE LOAD-BEARING CASE. Round 1 alone passes under the obvious
 * one-line fix, which is wrong. If someone "simplifies" this back to
 * invalidate-then-clear, round 1 stays green and round 2 is what fails.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Inv = { n: number }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string) {
  return createNoydb({ store, sync: remote, user, secret, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam() })
}

/** owner + a granted operator sharing one remote, with `notes/n1` at `{ n: 1 }`. */
async function twoDevices() {
  const remote = memoryStore()
  const dbO = await open(memoryStore(), remote, 'owner', S)
  const vO = await dbO.openVault('firm')
  await vO.collection<Inv>('notes').put('n1', { n: 1 })
  await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
  await dbO.push('firm')

  const dbU = await open(memoryStore(), remote, 'u1', U)
  const vU = await dbU.openVault('firm')
  await dbU.pull('firm')
  return { dbO, vO, dbU, vU }
}

/** Rewrites u1's keyring file, so the next pull triggers `_reloadKeyringAfterSync`. */
async function reGrant(dbO: Awaited<ReturnType<typeof twoDevices>>['dbO'], extra: Record<string, 'rw'>) {
  await dbO.grant('firm', {
    userId: 'u1', displayName: 'U', role: 'operator', secret: U,
    permissions: { notes: 'rw', ...extra },
  })
}

describe('family#192 — a handle held across a keyring-reloading pull', () => {
  it('1. a held handle sees a record that the keyring-reloading pull updated', async () => {
    const { dbO, vO, dbU, vU } = await twoDevices()
    const held = vU.collection<Inv>('notes')
    expect(await held.get('n1'), 'precondition: the handle reads before the pull').toEqual({ n: 1 })

    await vO.collection<Inv>('notes').put('n1', { n: 2 })
    await reGrant(dbO, { extra: 'rw' })   // rewrites u1's keyring -> triggers the reload
    await dbO.push('firm')
    await dbU.pull('firm')

    expect(await vU.collection<Inv>('notes').get('n1'), 'CONTROL: a FRESH handle must see it').toEqual({ n: 2 })
    expect(await held.get('n1'), 'the held handle served its pre-pull cache').toEqual({ n: 2 })
    await dbO.close(); await dbU.close()
  })

  it('2. THE LOAD-BEARING CASE: it is still invalidated on the NEXT pull', async () => {
    // ⛔ Round 1 passes under invalidate-then-clear, which is the obvious fix
    // and is wrong: clearing the map orphans the handle from
    // `_invalidateSyncApplied`, which resolves through `collectionCache.get()`.
    // This pull carries NO keyring change, so per-record invalidation is the
    // only thing that can reach the handle — and it can only reach it if the
    // instance is still registered.
    const { dbO, vO, dbU, vU } = await twoDevices()
    const held = vU.collection<Inv>('notes')
    await held.get('n1')

    await vO.collection<Inv>('notes').put('n1', { n: 2 })
    await reGrant(dbO, { extra: 'rw' })
    await dbO.push('firm')
    await dbU.pull('firm')
    expect(await held.get('n1')).toEqual({ n: 2 })

    // A plain record pull, no keyring involved.
    await vO.collection<Inv>('notes').put('n1', { n: 3 })
    await dbO.push('firm')
    await dbU.pull('firm')
    expect(await held.get('n1'), 'the handle was orphaned from per-record invalidation').toEqual({ n: 3 })
    await dbO.close(); await dbU.close()
  })

  it('3. a held handle survives a reload that MINTS a new DEK, and reads the new collection', async () => {
    // The key half. The held handle's resolver was assigned once into a
    // `readonly` field, while the reload REPLACES the vault's — and
    // `ensureCollectionDEK` captures the keyring OBJECT, so an already-resolved
    // resolver keeps answering from the pre-reload keyring. A collection whose
    // DEK arrives in that pull is exactly what the stale resolver cannot see.
    const { dbO, vO, dbU, vU } = await twoDevices()
    const heldNotes = vU.collection<Inv>('notes')
    await heldNotes.get('n1') // force the resolver to resolve and memoize

    await vO.collection<Inv>('invoices').put('inv-1', { n: 7 })
    await reGrant(dbO, { invoices: 'rw' })
    await dbO.push('firm')
    await dbU.pull('firm')

    expect(await vU.collection<Inv>('invoices').get('inv-1'), 'the newly granted DEK did not take effect').toEqual({ n: 7 })
    expect(await heldNotes.get('n1'), 'the pre-existing handle broke on the reload').toEqual({ n: 1 })
    await dbO.close(); await dbU.close()
  })

  it('6. a handle held for a collection whose DEK ARRIVES in the pull can read it', async () => {
    // ⭐ THE CASE THAT EARNS THE `getDEK` INDIRECTION ITS PLACE. Added after
    // mutation testing: reverting the indirection on its own reddened NOTHING,
    // because every other case's held handle only ever needs a DEK the OLD
    // keyring already had.
    //
    // The stale thing is the RESOLVER. `Collection.getDEK` is assigned once
    // into a `readonly` field, the reload REPLACES the vault's, and
    // `ensureCollectionDEK` captures the keyring OBJECT — so an
    // already-resolved resolver keeps answering from the pre-reload keyring.
    // Asking a held handle for a DEK that only the NEW keyring has is the only
    // way to see it: without the indirection this throws NoAccessError.
    const { dbO, vO, dbU, vU } = await twoDevices()
    // Acquire the handle BEFORE access exists — construction does not resolve a
    // key, so this is legal and is the shape a caller writes when it builds its
    // handles up front.
    const heldInvoices = vU.collection<Inv>('invoices')
    // Force the vault's resolver to resolve and MEMOIZE against today's keyring.
    await vU.collection<Inv>('notes').get('n1')

    await vO.collection<Inv>('invoices').put('inv-1', { n: 7 })
    await reGrant(dbO, { invoices: 'rw' })
    await dbO.push('firm')
    await dbU.pull('firm')

    expect(
      await heldInvoices.get('inv-1'),
      'the held handle resolved its DEK against the pre-pull keyring',
    ).toEqual({ n: 7 })
    await dbO.close(); await dbU.close()
  })

  it('4. CONTROL: a pull with no keyring change still invalidates a held handle', async () => {
    // Without this, cases 1-3 would also pass if the keyring path were the ONLY
    // thing that ever invalidated anything. This is the ordinary path, and it
    // must be untouched by the fix.
    const { dbO, vO, dbU, vU } = await twoDevices()
    const held = vU.collection<Inv>('notes')
    expect(await held.get('n1')).toEqual({ n: 1 })

    await vO.collection<Inv>('notes').put('n1', { n: 9 })
    await dbO.push('firm')
    await dbU.pull('firm')
    expect(await held.get('n1')).toEqual({ n: 9 })
    await dbO.close(); await dbU.close()
  })

  it('5. CONTROL: a handle obtained AFTER the pull is correct too', async () => {
    // The property the old code did get right. Keeping instances registered
    // instead of clearing the map must not break the fresh-handle path that
    // core#82(3) covers.
    const { dbO, vO, dbU, vU } = await twoDevices()
    await vO.collection<Inv>('notes').put('n1', { n: 4 })
    await reGrant(dbO, { extra: 'rw' })
    await dbO.push('firm')
    await dbU.pull('firm')
    expect(await vU.collection<Inv>('notes').get('n1')).toEqual({ n: 4 })
    await dbO.close(); await dbU.close()
  })
})
