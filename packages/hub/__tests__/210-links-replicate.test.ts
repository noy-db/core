/**
 * family#210, PR 2 — link sets replicate through the reserved mirror.
 *
 * Before this, `_links_*` reached no peer at all: `connect()` wrote the raw
 * adapter, the pull path filters every `_`-collection, and no rule named
 * `_links_*`. Links made on one device never arrived, and a restored device
 * lost them.
 *
 * ⭐ ENUMERATED SPECS, not a name pattern. The mirror's declared rule list is
 * what makes "which reserved records travel" auditable; a regex would move
 * that answer from a declaration into a match, and nothing would then say
 * which collections are in scope for a given vault. The vault enumerates its
 * declared link sets and the mirror applies ONE reviewed template to each.
 *
 * ⭐ `propagateDeletes: false` is PR 1's payoff, not an omission: removal
 * travels as a MARKER row that `versionSupersedes` carries like any other, so
 * absence-based deletion is unnecessary — and it is exactly the ambiguity the
 * marker removed.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple river stone'
interface Line extends Record<string, unknown> { id: string }

function open(store: NoydbStore, remote: NoydbStore) {
  return createNoydb({ store, sync: remote, user: 'owner', secret: S, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam() })
}

/** A device with the link set declared and both endpoint collections seeded. */
async function device(remote: NoydbStore, store = memoryStore({ full: true })) {
  const db = await open(store, remote)
  const v = await db.openVault('firm')
  await v.collection<Line>('sales').put('s1', { id: 's1' })
  await v.collection<Line>('purchases').put('p1', { id: 'p1' })
  await v.collection<Line>('purchases').put('p2', { id: 'p2' })
  v.link('salePurchase', { a: 'sales', b: 'purchases' })
  return { db, v, links: v.links('salePurchase'), store }
}

describe('family#210 — links replicate', () => {
  it('1. THE BUG: a link made on one device reaches the other', async () => {
    const remote = memoryStore({ full: true })
    const a = await device(remote)
    await a.links.connect('s1', 'p1')
    await a.db.push('firm')

    const b = await device(remote)
    await b.db.pull('firm')
    expect(await b.links.list(), 'the link never reached the peer').toEqual([{ a: 's1', b: 'p1' }])
    await a.db.close(); await b.db.close()
  })

  it('2. a REMOVAL reaches the other device too', async () => {
    // The half a physical delete could never do. The marker is a row, so it
    // rides the same version comparison as a connect.
    const remote = memoryStore({ full: true })
    const a = await device(remote)
    await a.links.connect('s1', 'p1')
    await a.db.push('firm')
    const b = await device(remote)
    await b.db.pull('firm')
    expect(await b.links.has('s1', 'p1')).toBe(true)

    await a.links.disconnect('s1', 'p1')
    await a.db.push('firm')
    await b.db.pull('firm')
    expect(await b.links.has('s1', 'p1'), 'the removal did not replicate').toBe(false)
    expect(await b.links.list()).toEqual([])
    await a.db.close(); await b.db.close()
  })

  it('3. a reconnect after a replicated removal wins on version', async () => {
    // This is why the marker must not churn the version on a double
    // disconnect (PR 1, case 5): a no-op bump would outrank this reconnect.
    const remote = memoryStore({ full: true })
    const a = await device(remote)
    await a.links.connect('s1', 'p1')
    await a.db.push('firm')
    const b = await device(remote)
    await b.db.pull('firm')
    await a.links.disconnect('s1', 'p1')
    await a.db.push('firm')
    await b.db.pull('firm')

    await b.links.connect('s1', 'p1')      // B reconnects AFTER seeing the removal
    await b.db.push('firm')
    await a.db.pull('firm')
    expect(await a.links.has('s1', 'p1'), "B's reconnect lost to the older removal").toBe(true)
    await a.db.close(); await b.db.close()
  })

  it('4. ⚠️ THE COST OF ENUMERATION: a device receives only the sets it has DECLARED', async () => {
    // ⚠️ This is the residual, not a win, and it is the price of the auditable
    // choice. The mirror carries a link collection because the vault
    // ENUMERATED it, so a device that has not called `vault.link()` before
    // pulling receives nothing for that set — silently. A `_links_*` NAME
    // PATTERN would not have this property: it would carry every link
    // collection the remote holds, declared locally or not.
    //
    // ⭐ Worth stating plainly because it shapes how a consumer must write
    // start-up code: declare your link sets BEFORE the first pull, exactly as
    // family#191 asks you to declare collections before the first write. Case
    // 5 is the same ordering seen from the other side.
    const remote = memoryStore({ full: true })
    const a = await device(remote)
    await a.links.connect('s1', 'p1')
    await a.db.push('firm')

    const plain = await open(memoryStore({ full: true }), remote)
    const pv = await plain.openVault('firm')
    await plain.pull('firm')
    const raw = await (plain as unknown as { options: { store: NoydbStore } }).options.store.list('firm', '_links_salePurchase')
    expect(raw, 'an undeclared link set was mirrored anyway').toEqual([])
    void pv
    await a.db.close(); await plain.close()
  })

  it('5. a set declared AFTER the sync target was attached is still mirrored', async () => {
    // The seam reads the enumeration PER SYNC rather than capturing it at
    // attach time, so a `vault.link()` that happens later counts. Captured
    // once, both sides of this would silently miss the set.
    //
    // ⚠️ Both devices declare BEFORE their sync call, which is the ordering
    // case 4 documents. My first version of this case declared on the peer
    // AFTER its pull and failed — correctly: nothing was enumerated at pull
    // time, so the mirror had no rule to apply. The failure was the design
    // telling me about itself.
    const remote = memoryStore({ full: true })
    const a = await device(remote)
    a.v.link('late', { a: 'sales', b: 'purchases' })   // declared after the target was attached
    await a.v.links('late').connect('s1', 'p2')
    await a.db.push('firm')

    const b = await open(memoryStore({ full: true }), remote)
    const bv = await b.openVault('firm')
    bv.link('late', { a: 'sales', b: 'purchases' })     // declared BEFORE the pull
    await b.pull('firm')
    expect(await bv.links('late').list()).toEqual([{ a: 's1', b: 'p2' }])
    await a.db.close(); await b.close()
  })
})
