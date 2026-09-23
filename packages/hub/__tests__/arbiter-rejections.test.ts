/**
 * core#107 — the writer finds out.
 *
 * core#74 judged an arriving record against the receiving device's rules, and
 * core#108 judged a dirty record against its own device's before it left.
 * Between them sits the case neither catches: C writes offline, pushes before
 * it has pulled the close, and every OTHER device refuses the record at
 * admission. Each parks it locally. C is never told.
 *
 * So the device configured as the vault's ARBITER replicates its refusals
 * through `_sync_rejections`, sealed under the refused record's own collection
 * DEK. Every device pulls it; the one holding that exact version parks it and
 * emits `sync:rejected` with `origin: 'arbiter'`.
 *
 * ⛔ REPORT ONLY, ruled: a replicated refusal never deletes, tombstones or
 * hides the record. The last case is the one that holds that line.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore, SyncRejection } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Note = { n: number; period: string }
type Close = { closed: boolean }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string, arbiter = false) {
  return createNoydb({
    store, sync: remote, user, secret, validateSecret: false,
    syncStrategy: withSync(arbiter ? { arbiter: true } : undefined), teamStrategy: withTeam(),
  })
}

function closedPeriodRule(db: Awaited<ReturnType<typeof createNoydb>>) {
  db.onBeforeWrite(async (e) => {
    if (e.collection !== 'notes' || e.after === null) return
    const close = await db.vault(e.vault).collection<Close>('closes').get((e.after as Note).period)
    if (close?.closed) throw new Error(`PERIOD_CLOSED: ${(e.after as Note).period}`)
  })
}

/** owner (the arbiter) + C (the offline writer) + D (no `notes` access). */
async function firm(arbiter = true) {
  const remote = memoryStore()
  const dbO = await open(memoryStore(), remote, 'owner', S, arbiter)
  const vO = await dbO.openVault('firm')
  await vO.collection<Close>('closes').put('2026-08', { closed: false })
  await dbO.grant('firm', { userId: 'C', displayName: 'C', role: 'operator', secret: U, permissions: { notes: 'rw', closes: 'rw' } })
  await dbO.grant('firm', { userId: 'D', displayName: 'D', role: 'operator', secret: U, permissions: { closes: 'ro' } })
  await dbO.push('firm')
  closedPeriodRule(dbO)
  const member = async (user: string) => {
    const local = memoryStore()
    const db = await open(local, remote, user, U)
    const v = await db.openVault('firm'); await db.pull('firm')
    closedPeriodRule(db)
    return { db, v, local }
  }
  return { remote, dbO, vO, member }
}

/** C writes offline, the period closes elsewhere, C pushes before it hears. */
async function offlineWriteThenClose(f: Awaited<ReturnType<typeof firm>>) {
  const C = await f.member('C')
  await C.v.collection<Note>('notes').put('c1', { n: 1, period: '2026-08' })
  await f.vO.collection<Close>('closes').put('2026-08', { closed: true })
  await f.dbO.push('firm')
  expect((await C.db.push('firm')).pushed).toBe(1)   // C has not pulled the close
  return C
}

describe('core#107 — an arbiter replicates its refusals', () => {
  it("the arbiter refuses C's record, and C learns about it on its next pull", async () => {
    const f = await firm()
    const C = await offlineWriteThenClose(f)

    // the arbiter pulls, refuses, and publishes
    const arb = await f.dbO.pull('firm')
    expect(arb.rejected?.map(r => r.id)).toEqual(['c1'])
    await f.dbO.push('firm')

    const heard: SyncRejection[] = []
    C.db.on('sync:rejected', (r) => heard.push(r))
    await C.db.pull('firm')

    expect(heard).toHaveLength(1)
    expect(heard[0]!.id).toBe('c1')
    expect(heard[0]!.origin).toBe('arbiter')
    expect(heard[0]!.reason).toMatch(/PERIOD_CLOSED: 2026-08/)
    expect((await C.db.rejected('firm').list()).map(r => r.id)).toContain('c1')
  })

  it('REPORT ONLY — the record is still there, on C and on the remote', async () => {
    const f = await firm()
    const C = await offlineWriteThenClose(f)
    await f.dbO.pull('firm'); await f.dbO.push('firm')
    await C.db.pull('firm')

    expect(await C.v.collection<Note>('notes').get('c1')).toEqual({ n: 1, period: '2026-08' })
    expect(await f.remote.get('firm', 'notes', 'c1')).not.toBeNull()
  })

  it('with NO arbiter configured, the refusal stays where it was made — the control', async () => {
    const f = await firm(false)
    const C = await offlineWriteThenClose(f)
    const arb = await f.dbO.pull('firm')
    expect(arb.rejected?.map(r => r.id)).toEqual(['c1'])   // still refused locally
    await f.dbO.push('firm')

    const heard: SyncRejection[] = []
    C.db.on('sync:rejected', (r) => heard.push(r))
    await C.db.pull('firm')
    expect(heard).toEqual([])
    expect(await f.remote.get('firm', '_sync_rejections', 'notes::c1')).toBeNull()
  })

  it('a member without the collection cannot open the refusal — it is sealed under the record\'s own DEK', async () => {
    const f = await firm()
    await offlineWriteThenClose(f)
    await f.dbO.pull('firm'); await f.dbO.push('firm')

    // D holds `closes` but not `notes`: the envelope reaches it and stays shut
    const D = await f.member('D')
    const heard: SyncRejection[] = []
    D.db.on('sync:rejected', (r) => heard.push(r))
    await D.db.pull('firm')

    // ⭐ the control that stops this passing vacuously: the envelope REACHED D's
    // own store. Without it, "D heard nothing" is equally true of a D that was
    // never sent anything, which would test the mirror instead of the seal.
    expect(await D.local.get('firm', '_sync_rejections', 'notes::c1')).not.toBeNull()
    expect(heard).toEqual([])
    // ⚠️ D's store DOES hold `notes/c1` — sync replicates ciphertext to every
    // device and access control is key possession, not record distribution. So
    // the control is that D cannot OPEN it, which is the same reason it cannot
    // open the refusal about it.
    expect(await D.local.get('firm', 'notes', 'c1')).not.toBeNull()
    await expect(D.v.collection<Note>('notes').get('c1')).rejects.toBeInstanceOf(NoAccessError)
  })

  it('the same refusal is not reported twice — the parking record is the dedupe', async () => {
    const f = await firm()
    const C = await offlineWriteThenClose(f)
    await f.dbO.pull('firm'); await f.dbO.push('firm')

    const heard: SyncRejection[] = []
    C.db.on('sync:rejected', (r) => heard.push(r))
    await C.db.pull('firm')
    expect(heard).toHaveLength(1)
    await C.db.pull('firm')
    expect(heard).toHaveLength(1)
  })

  it('a refusal about a version C has already moved past is ignored', async () => {
    const f = await firm()
    const C = await offlineWriteThenClose(f)
    await f.dbO.pull('firm'); await f.dbO.push('firm')

    // C edits the record before it ever hears: the refusal names v1, C now holds v2.
    // Its own rule refuses the edit, so move it to a period that is still open —
    // the point is the VERSION moving, not the rule passing.
    await C.v.collection<Note>('notes').put('c1', { n: 2, period: '2026-09' })
    expect((await C.local.get('firm', 'notes', 'c1'))!._v).toBe(2)

    const heard: SyncRejection[] = []
    C.db.on('sync:rejected', (r) => heard.push(r))
    await C.db.pull('firm')

    // the envelope is here and readable by C — this is the version filter, not the seal
    expect(await C.local.get('firm', '_sync_rejections', 'notes::c1')).not.toBeNull()
    expect(heard).toEqual([])
  })
})
