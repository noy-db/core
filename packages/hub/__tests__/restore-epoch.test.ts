/**
 * core#72 / core#71 — a restore becomes the truth on the target and on every
 * device. pilot-1's run (real DynamoDB): after `vault.load(pod)` the sync
 * state was untouched, `push({ full })` was CAS-refused for every pod record,
 * nothing was tombstoned, every device — the restorer included — converged
 * back to the live state, and the only durable effect was a resurrected
 * delete. Their five asks are this file's cases.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Rec = { n: number }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string) {
  // History OFF, deliberately (`vault.dump()` is not history-gated — measured; the
  // `strategy-opt-in` row says otherwise, hence the explicit key). With history on,
  // restoring an OLDER pod over a store whose ledger moved on is refused by the
  // integrity check (`BackupCorruptedError`: a ledger entry for a record the pod
  // lacks) — a separate limitation of `load()`, #111.
  return createNoydb({ store, sync: remote, user, secret, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam(), ...NO_HISTORY })
}
const NO_HISTORY: { historyStrategy?: never } = {}
const ids = async (store: NoydbStore) => (await store.list('firm', 'notes')).sort()
async function liveIds(store: NoydbStore): Promise<string[]> {
  const out: string[] = []
  for (const id of await store.list('firm', 'notes')) {
    const env = (await store.get('firm', 'notes', id))!
    if (!(env as { _del?: unknown })._del) out.push(id)
  }
  return out.sort()
}

/** pilot-1's sequence up to the restore: pod at T0 (10 records), then B and C diverge. */
async function scenario() {
  const remote = memoryStore()
  const localA = memoryStore()
  const dbA = await open(localA, remote, 'owner', S)
  const vA = await dbA.openVault('firm')
  for (let i = 0; i < 10; i++) await vA.collection<Rec>('notes').put(`pre-${i}`, { n: i })
  await dbA.grant('firm', { userId: 'B', displayName: 'B', role: 'operator', secret: U, permissions: { notes: 'rw' } })
  await dbA.push('firm')
  const pod = await vA.dump()

  const localB = memoryStore()
  const dbB = await open(localB, remote, 'B', U)
  const vB = await dbB.openVault('firm'); await dbB.pull('firm')
  for (let i = 0; i < 3; i++) await vB.collection<Rec>('notes').put(`b-${i}`, { n: 100 + i })
  await vB.collection<Rec>('notes').put('pre-1', { n: 1001 })   // edited after T0
  await vB.collection<Rec>('notes').delete('pre-2')              // deleted after T0
  await dbB.push('firm')

  const localC = memoryStore()
  const dbC = await open(localC, remote, 'owner', S)
  const vC = await dbC.openVault('firm'); await dbC.pull('firm')
  for (let i = 0; i < 3; i++) await vC.collection<Rec>('notes').put(`c-${i}`, { n: 200 + i })
  await dbC.push('firm')
  await dbA.pull('firm')
  expect(await liveIds(remote)).toHaveLength(15) // 10 - 1 + 3 + 3
  return { remote, localA, dbA, vA, pod, localB, dbB, vB, localC, dbC, vC }
}
const POD_IDS = Array.from({ length: 10 }, (_, i) => `pre-${i}`).sort()

describe('core#72 — replaceRemote: the restore is the truth on the target', () => {
  it('force, tombstones for absence, the epoch, the counts — and the restorer\'s own next pull brings nothing back', async () => {
    const { remote, localA, dbA, vA, pod } = await scenario()
    await vA.load(pod)
    expect(dbA.syncTargetStatus('firm')[0]).toMatchObject({ dirty: 0, lastPush: null, lastPull: null }) // core#71: a new base
    const r = await dbA.replaceRemote('firm')
    expect(r).toMatchObject({ epoch: 1, replaced: 10, tombstoned: 6 })
    expect(await liveIds(remote)).toEqual(POD_IDS)                      // b-* and c-* are markers now
    expect((await remote.get('firm', 'notes', 'pre-1'))!._v).toBe(3)    // lifted above the target's v2
    expect((await remote.get('firm', 'notes', 'pre-2'))!._v).toBe(3)    // lifted above the delete marker's v2
    expect(dbA.syncTargetStatus('firm')[0]).toMatchObject({ dirty: 0, epoch: 1 })
    const again = await dbA.pull('firm')
    expect(again.pulled).toBe(0)
    expect(again.resynced).toBeUndefined()                               // the restorer adopted its own epoch
    expect(await liveIds(localA)).toEqual(POD_IDS)
    expect(await vA.collection<Rec>('notes').get('pre-1')).toEqual({ n: 1 })
  })

  it('every other device crosses the epoch: adopts the restore, drops what it added, sees the deleted record back — and its unpushed edit is parked, not lost', async () => {
    const { remote, dbA, vA, pod, localB, dbB, vB, localC, dbC, vC } = await scenario()
    await vB.collection<Rec>('notes').put('b-unpushed', { n: 999 })      // B's pending local edit at restore time
    await vA.load(pod); await dbA.replaceRemote('firm')

    const rb = await dbB.pull('firm')
    expect(rb.resynced).toBe(true)
    expect(rb.epoch).toBe(1)
    expect(rb.conflicts).toEqual([])
    expect(await liveIds(localB)).toEqual(POD_IDS)
    expect(await vB.collection<Rec>('notes').get('pre-1')).toEqual({ n: 1 })     // B's post-T0 edit discarded
    expect(await vB.collection<Rec>('notes').get('pre-2')).toEqual({ n: 2 })     // B's post-T0 delete undone, deliberately
    expect(await vB.collection<Rec>('notes').get('b-0')).toBeNull()
    const parked = await dbB.rejected('firm').list()
    expect(parked.map(p => p.id)).toEqual(['b-unpushed'])
    expect(parked[0]!.reason).toMatch(/restore-epoch/)
    expect(dbB.syncTargetStatus('firm')[0]).toMatchObject({ dirty: 0, epoch: 1 })
    expect((await dbB.push('firm')).pushed).toBe(0)                               // nothing stale goes back

    const rc = await dbC.pull('firm')
    expect(rc.resynced).toBe(true)
    expect(await liveIds(localC)).toEqual(POD_IDS)
    expect(await vC.collection<Rec>('notes').get('c-1')).toBeNull()

    const dbD = await open(memoryStore(), remote, 'owner', S)                       // a fresh device after everything
    const vD = await dbD.openVault('firm'); const rd = await dbD.pull('firm')
    expect(rd.epoch).toBe(1)
    expect(await vD.collection<Rec>('notes').get('pre-2')).toEqual({ n: 2 })
    expect(await vD.collection<Rec>('notes').get('c-0')).toBeNull()
    expect(await liveIds(remote)).toEqual(POD_IDS)                                  // and the target is still the pod
  })

  it('a second pull after crossing is ordinary: no resync, no parking twice; readmit of a parked edit keeps it locally', async () => {
    const { dbA, vA, pod, dbB, vB } = await scenario()
    await vB.collection<Rec>('notes').put('b-unpushed', { n: 999 })
    await vA.load(pod); await dbA.replaceRemote('firm')
    await dbB.pull('firm')
    const second = await dbB.pull('firm')
    expect(second.resynced).toBeUndefined()
    expect(second.rejected).toBeUndefined()
    await dbB.rejected('firm').readmit('notes', 'b-unpushed')
    expect(await vB.collection<Rec>('notes').get('b-unpushed')).toEqual({ n: 999 })
    await vB.collection<Rec>('notes').put('b-unpushed', { n: 999 })                 // put again to push, as the reason says
    expect((await dbB.push('firm')).pushed).toBe(1)
  })

  it('a second replace bumps the epoch again and peers cross it again', async () => {
    const { dbA, vA, pod, dbB } = await scenario()
    await vA.load(pod); await dbA.replaceRemote('firm'); await dbB.pull('firm')
    await vA.collection<Rec>('notes').put('after-1', { n: 1 })
    const pod2 = await vA.dump()
    await vA.collection<Rec>('notes').put('after-2', { n: 2 }); await dbA.push('firm')
    await vA.load(pod2)
    const r = await dbA.replaceRemote('firm')
    expect(r).toMatchObject({ epoch: 2, tombstoned: 1 })
    const rb = await dbB.pull('firm')
    expect(rb).toMatchObject({ resynced: true, epoch: 2 })
  })
})

describe('core#71 — vault.load() is sync-aware', () => {
  it('a restore resets the dirty log and the watermarks: push afterwards pushes nothing stale', async () => {
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    await vA.collection<Rec>('notes').put('n1', { n: 1 })
    await dbA.push('firm')
    const pod = await vA.dump()
    await vA.collection<Rec>('notes').put('n2', { n: 2 })                          // dirty, never pushed
    expect(dbA.syncTargetStatus('firm')[0]!.dirty).toBe(1)
    await vA.load(pod)
    expect(dbA.syncTargetStatus('firm')[0]).toMatchObject({ dirty: 0, lastPush: null, lastPull: null })
    expect((await dbA.push('firm')).pushed).toBe(0)
    expect(await remote.get('firm', 'notes', 'n2')).toBeNull()
  })
})
