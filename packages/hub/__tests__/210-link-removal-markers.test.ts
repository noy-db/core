/**
 * family#210, PR 1 — `disconnect()` writes a removal marker instead of
 * deleting the row.
 *
 * ## Why a marker
 *
 * A physical delete cannot replicate. The reserved mirror infers removal from
 * ABSENCE, and absence is ambiguous for a set both devices can add to: A
 * disconnecting `x–y` while B connects it is indistinguishable from B simply
 * not having seen it yet. A marker says *removed here, at this version*, which
 * the version comparison resolves like any other row.
 *
 * The stored-shape change is ruled and accepted. `_del` goes on the ENVELOPE —
 * hub's existing delete-marker convention (#589), which `@noy-db/ports`' `/to`
 * suite already requires every store to round-trip byte-identically. A body
 * field would be invisible to anything that cannot decrypt, including the sync
 * mover, which is the whole reason it is where it is.
 *
 * ## ⚠️ The pre-marker residual, asserted in case 6
 *
 * A hub build from before this change fails OPEN on a tombstone: its `has()`
 * was `get(...) !== null`, and a tombstone is a row that EXISTS. Case 6 runs
 * that exact predicate and asserts it, so the residual is recorded by
 * something that executes rather than by a sentence.
 *
 * ⛔ It cannot be fixed from here, and the codebase says why: `errors.ts`
 * declares `'generation-mismatch'` for precisely this situation — "the
 * artefact was sealed at a generation this reader cannot compute" — and
 * states it is **not emitted by this build**, because "hub reads no generation
 * stamp off any envelope". So an old build has nothing to branch on. Making
 * the row undecryptable instead would surface as `TamperedError`, which is
 * reserved for genuine corruption and would misreport a format difference as
 * an attack.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

function memory(): { store: NoydbStore; raw: Map<string, EncryptedEnvelope> } {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v} ${c} ${i}`
  const store = {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v: string, c: string, i: string) { return data.get(k(v, c, i)) ?? null },
    async put(v: string, c: string, i: string, env: EncryptedEnvelope) { data.set(k(v, c, i), env) },
    async delete(v: string, c: string, i: string) { data.delete(k(v, c, i)) },
    async list(v: string, c: string) {
      const prefix = `${v} ${c} `
      return [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    },
    async loadAll() { return {} },
    async saveAll() {},
  } as unknown as NoydbStore
  return { store, raw: data }
}

interface Line extends Record<string, unknown> { id: string; label: string }

describe('family#210 — link removal markers', () => {
  let db: Noydb
  let raw: Map<string, EncryptedEnvelope>

  beforeEach(async () => {
    const m = memory()
    raw = m.raw
    db = await createNoydb({ store: m.store, user: 'alice', secret: 'links-secret-2026' })
  })

  async function linked() {
    const v = await db.openVault('firm')
    const sales = v.collection<Line>('saleLines')
    const purchases = v.collection<Line>('purchaseLines')
    await sales.put('s1', { id: 's1', label: 'sale 1' })
    await purchases.put('p1', { id: 'p1', label: 'purchase 1' })
    await purchases.put('p2', { id: 'p2', label: 'purchase 2' })
    v.link('saleLineLinks', { a: 'saleLines', b: 'purchaseLines' })
    const links = v.links('saleLineLinks')
    await links.connect('s1', 'p1')
    return { v, links }
  }

  const linkRows = () => [...raw.keys()].filter((key) => key.includes(' _links_'))

  it('1. disconnect LEAVES the row behind, as a marker', async () => {
    const { links } = await linked()
    expect(linkRows().length, 'precondition: one link row exists').toBe(1)
    await links.disconnect('s1', 'p1')
    expect(linkRows().length, 'the row was physically deleted — a peer could never learn of the removal').toBe(1)
    expect(raw.get(linkRows()[0]!)!._del, 'the surviving row is not marked as a removal').toBe(true)
  })

  it('2. has() is false for a removed link, even though the row exists', async () => {
    const { links } = await linked()
    expect(await links.has('s1', 'p1')).toBe(true)
    await links.disconnect('s1', 'p1')
    expect(await links.has('s1', 'p1'), 'has() reported a removed link as present').toBe(false)
  })

  it('3. list() and of() exclude a removed link', async () => {
    const { links } = await linked()
    await links.connect('s1', 'p2')
    await links.disconnect('s1', 'p1')
    expect(await links.list()).toEqual([{ a: 's1', b: 'p2' }])
    expect(await links.of('s1')).toEqual([{ a: 's1', b: 'p2' }])
    expect(await links.of('p1'), 'the removed endpoint still reported a row').toEqual([])
  })

  it('4. reconnecting a removed link works, and reads as live again', async () => {
    const { links } = await linked()
    await links.disconnect('s1', 'p1')
    await links.connect('s1', 'p1', { note: 'back' })
    expect(await links.has('s1', 'p1')).toBe(true)
    expect(await links.list()).toEqual([{ a: 's1', b: 'p1', meta: { note: 'back' } }])
    expect(raw.get(linkRows()[0]!)!._del, 'the resurrected row is still marked removed').toBeUndefined()
  })

  it('5. disconnecting twice is idempotent and does not churn the version', async () => {
    // Version churn would make a no-op win a version comparison against a
    // peer's real reconnect, which is the whole mechanism this PR sets up.
    const { links } = await linked()
    await links.disconnect('s1', 'p1')
    const afterFirst = raw.get(linkRows()[0]!)!._v
    await links.disconnect('s1', 'p1')
    expect(raw.get(linkRows()[0]!)!._v, 'a second disconnect bumped the version').toBe(afterFirst)
  })

  it('6. ⚠️ THE RESIDUAL: a pre-marker reader fails OPEN on a tombstone', async () => {
    // Asserts what an OLD build does, using its exact predicate. This is not
    // desirable behaviour — it is the documented consequence of the ruled
    // stored-shape change, recorded by something that runs.
    //
    // ⛔ If this ever flips, it means a generation stamp landed and old builds
    // now refuse: update this case rather than deleting it, and say so in the
    // CHANGELOG — `errors.ts` already commits to that for
    // `'generation-mismatch'`.
    const { links } = await linked()
    await links.disconnect('s1', 'p1')
    const key = linkRows()[0]!
    const env = raw.get(key)!
    const preMarkerHas = env !== null && env !== undefined // the old `get(...) !== null`
    expect(preMarkerHas, 'a pre-marker build would see the removal — if not, a stamp landed').toBe(true)
  })

  it('7. CONTROL: a link that was never removed is untouched by any of this', async () => {
    const { links } = await linked()
    expect(await links.has('s1', 'p1')).toBe(true)
    expect(await links.list()).toEqual([{ a: 's1', b: 'p1' }])
    expect(raw.get(linkRows()[0]!)!._del).toBeUndefined()
  })
})
