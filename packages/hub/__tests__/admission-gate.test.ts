/**
 * core#74 — an admission gate on INCOMING records, and per-record visibility
 * of what a pull did. pilot-1's concurrent-writers probe (real DynamoDB):
 * an offline write into a period closed elsewhere landed on every device
 * with zero guard evaluations, and a same-id concurrent edit was reported
 * once to the SECOND writer, then silently replaced the first writer's record.
 *
 * Now the vault's `beforePut` gate bus and `db.onBeforeWrite` hooks run on
 * the decrypted incoming record against this device's state at admission
 * (`origin: 'sync-apply'`). A refusal parks the envelope under
 * `_sync_rejected`, leaves the local copy untouched, reports it in
 * `PullResult.rejected` and emits `sync:rejected`; `db.rejected(vault)` lists,
 * readmits or discards. `PullResult.applied[]` names every applied record
 * with what it replaced.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withGuard } from '../src/with-audit/guards/with-guard.js'
import type { NoydbStore, SyncRejection, SyncApplied } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Note = { n: number; period: string }
type Close = { closed: boolean }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string, extra: Record<string, unknown> = {}) {
  return createNoydb({ store, sync: remote, user, secret, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam(), ...extra })
}

/** owner + operators B and C on `notes` and `closes`; C is the offline writer. */
async function firm() {
  const remote = memoryStore()
  const dbO = await open(memoryStore(), remote, 'owner', S)
  const vO = await dbO.openVault('firm')
  await vO.collection<Close>('closes').put('2026-08', { closed: false })
  await vO.collection<Note>('notes').put('n1', { n: 1, period: '2026-08' })
  for (const u of ['B', 'C']) await dbO.grant('firm', { userId: u, displayName: u, role: 'operator', secret: U, permissions: { notes: 'rw', closes: 'rw' } })
  await dbO.push('firm')
  const openMember = async (user: string) => {
    const local = memoryStore()
    const db = await open(local, remote, user, U)
    const v = await db.openVault('firm'); await db.pull('firm')
    return { db, v, local }
  }
  return { remote, dbO, vO, openMember }
}

/** the firm's rule, as pilot-1 writes it: a writer-side hook that reads ANOTHER collection's local state. */
function closedPeriodRule(db: ReturnType<typeof createNoydb> extends Promise<infer T> ? T : never) {
  db.onBeforeWrite(async (e) => {
    if (e.collection !== 'notes' || e.after === null) return
    const period = (e.after as Note).period
    const close = await db.vault(e.vault).collection<Close>('closes').get(period)
    if (close?.closed) throw new Error(`PERIOD_CLOSED: ${period} is closed (${e.origin ?? 'local-write'})`)
  })
}

describe('core#74 — the gate runs on incoming records', () => {
  it('an offline write into a period closed elsewhere is REFUSED at admission, parked, reported, emitted — and the local copy is untouched', async () => {
    const { dbO, vO, openMember } = await firm()
    const B = await openMember('B'); closedPeriodRule(B.db)
    const C = await openMember('C'); closedPeriodRule(C.db)
    // the writer-side rule works on B
    await vO.collection<Close>('closes').put('2026-08', { closed: true }); await dbO.push('firm')
    await B.db.pull('firm')
    await expect(B.v.collection<Note>('notes').put('nB', { n: 2, period: '2026-08' })).rejects.toThrow(/PERIOD_CLOSED/)
    // C never pulled the close: its own guard allows the write, it reconnects and pushes
    await C.v.collection<Note>('notes').put('c-offline', { n: 3, period: '2026-08' })
    expect((await C.db.push('firm')).pushed).toBe(1)

    const events: SyncRejection[] = []
    B.db.on('sync:rejected', (r) => events.push(r))
    const r = await B.db.pull('firm')
    expect(r.errors).toEqual([])
    expect(r.rejected?.map(x => `${x.collection}/${x.id}`)).toEqual(['notes/c-offline'])
    expect(r.rejected![0]!.reason).toMatch(/PERIOD_CLOSED.*sync-apply/)
    expect(r.pulled).toBe(0)
    expect(events).toHaveLength(1)
    expect(await B.v.collection<Note>('notes').get('c-offline')).toBeNull()      // untouched
    expect(await B.local.get('firm', 'notes', 'c-offline')).toBeNull()
    expect(await B.local.list('firm', '_sync_rejected')).toEqual(['notes::c-offline'])

    const parked = await B.db.rejected('firm').list()
    expect(parked.map(p => p.id)).toEqual(['c-offline'])
    expect(parked[0]!.by).toBe('C')
    // fate 1: readmit — the envelope applies after all, bypassing the gate
    await B.db.rejected('firm').readmit('notes', 'c-offline')
    expect(await B.v.collection<Note>('notes').get('c-offline')).toEqual({ n: 3, period: '2026-08' })
    expect(await B.db.rejected('firm').list()).toEqual([])
    // a second pull does not refuse it again (same version, same bytes, already held)
    expect((await B.db.pull('firm')).rejected).toBeUndefined()
  })

  it('fate 2: discard drops the parking record and keeps the local copy as it was', async () => {
    const { dbO, vO, openMember } = await firm()
    const B = await openMember('B'); closedPeriodRule(B.db)
    const C = await openMember('C')
    await vO.collection<Close>('closes').put('2026-08', { closed: true }); await dbO.push('firm'); await B.db.pull('firm')
    await C.v.collection<Note>('notes').put('c-offline', { n: 3, period: '2026-08' }); await C.db.push('firm')
    await B.db.pull('firm')
    await B.db.rejected('firm').discard('notes', 'c-offline')
    expect(await B.db.rejected('firm').list()).toEqual([])
    expect(await B.v.collection<Note>('notes').get('c-offline')).toBeNull()
    // the parking collection is this device's alone: a full push never sends it
    const full = await B.db.push('firm', { full: true })
    expect(full.errors).toEqual([])
    expect(await dbO.pull('firm').then(() => vO.collection<Note>('notes').get('c-offline'))).toEqual({ n: 3, period: '2026-08' })
  })

  it('a beforePut gate on the bus (withGuard) judges incoming records too, and sees origin: sync-apply', async () => {
    const remote = memoryStore()
    const seen: string[] = []
    const guard = withGuard<Note>({ collection: 'notes', check: (incoming, ctx) => { seen.push(ctx.origin ?? 'local-write'); if (incoming.n < 0) throw new Error('NEGATIVE') } })
    const dbO = await open(memoryStore(), remote, 'owner', S)
    const vO = await dbO.openVault('firm')
    await vO.collection<Note>('notes').put('n1', { n: 1, period: 'p' })
    await dbO.grant('firm', { userId: 'B', displayName: 'B', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')
    const dbB = await open(memoryStore(), remote, 'B', U, { guardStrategies: [guard] })
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(seen).toEqual(['sync-apply'])
    await vO.collection<Note>('notes').put('bad', { n: -1, period: 'p' }); await dbO.push('firm')
    const r = await dbB.pull('firm')
    expect(r.rejected?.[0]).toMatchObject({ collection: 'notes', id: 'bad', reason: 'NEGATIVE' })
    await expect(vB.collection<Note>('notes').put('local-bad', { n: -5, period: 'p' })).rejects.toThrow('NEGATIVE')
    expect(seen).toEqual(['sync-apply', 'sync-apply', 'local-write'])
  })

  it('never gated: deletes, and records this device holds no key for', async () => {
    const remote = memoryStore()
    const dbO = await open(memoryStore(), remote, 'owner', S)
    const vO = await dbO.openVault('firm')
    await vO.collection<Note>('notes').put('n1', { n: 1, period: 'p' })
    await vO.collection<Note>('secret').put('s1', { n: 1, period: 'p' })
    await dbO.grant('firm', { userId: 'B', displayName: 'B', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')
    const dbB = await open(memoryStore(), remote, 'B', U)
    const vB = await dbB.openVault('firm')
    dbB.onBeforeWrite(() => { throw new Error('REFUSE-EVERYTHING') })
    const r = await dbB.pull('firm')
    expect(r.rejected?.map(x => x.id)).toEqual(['n1'])          // notes: judged and refused
    expect(r.applied?.some(a => a.collection === 'secret')).toBe(true) // no key → cannot judge → applied
    await expect(vB.collection<Note>('secret').get('s1')).rejects.toBeInstanceOf(NoAccessError)
    await vO.collection<Note>('notes').delete('n1'); await dbO.push('firm')
    const r2 = await dbB.pull('firm')
    expect(r2.rejected).toBeUndefined()
    expect(r2.applied?.map(a => `${a.id}:${a.action}`)).toEqual(['n1:delete'])
  })
})

describe('core#74 — applied[]: what a pull did, and what it replaced', () => {
  it('a same-id concurrent edit: the first writer learns it lost through replaced { version, by }', async () => {
    const { openMember } = await firm()
    const B = await openMember('B')
    const C = await openMember('C')
    await B.v.collection<Note>('notes').put('n1', { n: 10, period: 'p' }); await B.db.push('firm')       // B: v2
    await C.v.collection<Note>('notes').put('n1', { n: 20, period: 'p' })
    const cPush = await C.db.push('firm')                                                                    // C: v2 vs remote v2 → tie, last pusher wins at v3
    expect(cPush.conflicts).toHaveLength(1)
    const r = await B.db.pull('firm')
    const entry = r.applied?.find(a => a.id === 'n1') as SyncApplied
    expect(entry).toBeDefined()
    expect(entry.replaced).toMatchObject({ version: 2 })
    expect(entry.replaced?.by).toBe('B')
    expect(await B.v.collection<Note>('notes').get('n1')).toEqual({ n: 20, period: 'p' })
  })
})
