/**
 * core#96, pilot-1's two findings on the direct cloud shape (real DynamoDB +
 * STS, reported 2026-09-22):
 *
 *  A. An OPEN session received the inbox at pull but never drained it — the
 *     in-session roster reload (core#82) re-derived the KEK from the secret the
 *     vault was OPENED with, which after an in-session `rotateSecret` is stale;
 *     the reload failed into `PullResult.errors` and the file was adopted by
 *     nobody. Same cause when another device drained first. Fixed: the reload
 *     uses the KEK the session holds.
 *  B. `updateUser` on a stale owner copy (owner at epoch 4, target at 5) pushed
 *     as the loser of the epoch rule and the box vanished silently. Fixed two
 *     ways: every authority edit first refreshes the member's file from each
 *     sync target; and a push that discards a stale local keyring reports it as
 *     a `_keyring` conflict.
 *  And the small one: `reserved` on push/pull results, so "did my new key get
 *  out" is observable (a keyring never counts in `pushed`).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { PERSONAL_POLICY } from '../src/with-party/policy/presets.js'
import { parseKeyringEnvelope, updateKeyringIdentity } from '../src/with-party/team/keyring.js'
import type { NoydbStore, KeyringFile, SyncTarget } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
const U2 = 'user-rotated-phrase-xyz'
type Inv = { n: number }
// rotate-secret needs a second factor on the default policy; the in-session rotation under test is the point, not the factor
const ROTATE_FREE = { ...PERSONAL_POLICY, gates: { ...PERSONAL_POLICY.gates, 'rotate-secret': { minTier: 1 as const } } }

function open(store: NoydbStore, remote: NoydbStore | undefined, user: string, secret: string) {
  return createNoydb({ store, ...(remote ? { sync: remote } : {}), user, secret, validateSecret: false, policy: ROTATE_FREE, syncStrategy: withSync(), teamStrategy: withTeam() })
}
async function file(store: NoydbStore, user: string): Promise<KeyringFile> {
  return parseKeyringEnvelope((await store.get('firm', '_keyring', user))!)
}
const peer = (store: NoydbStore, label: string): SyncTarget => ({ store, role: 'sync-peer', label })

async function seed() {
  const remote = memoryStore()
  const localO = memoryStore()
  const dbO = await open(localO, remote, 'owner', S)
  const vO = await dbO.openVault('firm')
  await vO.collection<Inv>('notes').put('n1', { n: 1 })
  await vO.collection<Inv>('invoices').put('inv-1', { n: 10 })
  await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
  await dbO.push('firm')
  return { remote, localO, dbO, vO }
}

describe('finding A — an open session drains a delivery at its next pull', () => {
  it('rotateSecret IN SESSION (the opened-with secret is stale), then the owner widens — readable after pull, no reopen', async () => {
    const { remote, dbO } = await seed()
    const localU = memoryStore()
    const dbU = await open(localU, remote, 'u1', U) // fresh device: the keyring bootstraps from the target
    const vU = await dbU.openVault('firm')
    await dbU.attachSyncTarget('firm', peer(memoryStore(), 'backup')) // a second target, attached after open
    await dbU.pull('firm')
    await dbU.team.rotateSecret('firm', { oldSecret: U, newSecret: U2, allowWeakSecret: true })
    await dbU.push('firm')
    await expect(vU.collection<Inv>('invoices').get('inv-1')).rejects.toBeInstanceOf(NoAccessError)

    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    const r = await dbU.pull('firm')
    expect(r.errors).toEqual([])
    expect(await vU.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 })
    expect((await file(localU, 'u1')).inbox).toBeUndefined() // drained and re-persisted by the reload
  })

  it('another device drained first: the open session adopts the drained file at pull', async () => {
    const { remote, dbO } = await seed()
    const dbU = await open(memoryStore(), remote, 'u1', U)
    const vU = await dbU.openVault('firm'); await dbU.pull('firm')
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    const dbB = await open(memoryStore(), remote, 'u1', U)
    await dbB.openVault('firm'); await dbB.pull('firm'); await dbB.push('firm') // B drains and pushes the drained file
    expect((await file(remote, 'u1')).inbox).toBeUndefined()
    const r = await dbU.pull('firm')
    expect(r.errors).toEqual([])
    expect(await vU.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 })
  })

  it('a file re-keyed under the session by someone else is a defined event: InvalidKeyError in errors, not a hang', async () => {
    const { remote, dbO } = await seed()
    const dbU = await open(memoryStore(), remote, 'u1', U)
    await dbU.openVault('firm'); await dbU.pull('firm')
    await dbO.team.recoverUser('firm', { userId: 'u1', secret: 'temp-bridge-secret-1', allowWeakSecret: true })
    await dbO.push('firm')
    const r = await dbU.pull('firm')
    expect(r.errors.map(e => e.name)).toEqual(['InvalidKeyError'])
  })
})

describe('finding B — an authority edit on a stale copy is never silently lost', () => {
  it('updateUser refreshes the member file from the target first, so the widening lands on the current epoch', async () => {
    const { remote, localO, dbO } = await seed()
    // the member drains on their device and pushes: target epoch moves ahead of the owner's copy
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    const dbU = await open(memoryStore(), remote, 'u1', U)
    await dbU.openVault('firm'); await dbU.pull('firm'); await dbU.push('firm')
    const ownerEpoch = (await file(localO, 'u1')).roster_epoch!
    const targetEpoch = (await file(remote, 'u1')).roster_epoch!
    expect(targetEpoch).toBe(ownerEpoch + 1)

    // the owner does NOT pull; the edit refreshes by itself
    const vO = dbO.vault('firm')
    await vO.collection<Inv>('extra').put('e1', { n: 5 })
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw', extra: 'rw' } })
    expect((await file(localO, 'u1')).roster_epoch).toBe(targetEpoch + 1)
    const r = await dbO.push('firm')
    expect(r.conflicts).toEqual([])
    expect((await file(remote, 'u1')).inbox?.slots).toEqual(['extra'])
    const dbB = await open(memoryStore(), remote, 'u1', U)
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await vB.collection<Inv>('extra').get('e1')).toEqual({ n: 5 })
    expect(await vB.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 }) // the earlier delivery survived
  })

  it('a stale keyring pushed around the kernel is reported as a _keyring conflict, not dropped silently', async () => {
    const { remote, localO, dbO } = await seed()
    const dbU = await open(memoryStore(), remote, 'u1', U)
    await dbU.openVault('firm')
    await dbU.team.rotateSecret('firm', { oldSecret: U, newSecret: U2, allowWeakSecret: true }) // target epoch +1
    await dbU.push('firm')
    // write on the owner's stale copy through the engine directly (bypassing the kernel's refresh)
    const keyring = await dbO.team.getKeyring('firm')
    await updateKeyringIdentity(localO, 'firm', keyring, { userId: 'u1', displayName: 'Stale Edit' })
    const r = await dbO.push('firm')
    expect(r.conflicts.map(c => `${c.collection}/${c.id}`)).toEqual(['_keyring/u1'])
    expect((await file(remote, 'u1')).display_name).toBe('U') // remote kept its (newer) copy
  })
})

describe('reserved on push/pull results', () => {
  it('a grant reaches the target as reserved: n while pushed stays 0; a pull that brings a keyring reports it too', async () => {
    const remote = memoryStore()
    const dbO = await open(memoryStore(), remote, 'owner', S)
    await dbO.openVault('firm')
    await dbO.push('firm')
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'viewer', secret: U })
    const r = await dbO.push('firm')
    expect(r.pushed).toBe(0)
    expect(r.reserved).toBeGreaterThanOrEqual(1)
    const dbB = await open(memoryStore(), remote, 'owner', S)
    await dbB.openVault('firm')
    const p = await dbB.pull('firm')
    expect(p.reserved).toBeGreaterThanOrEqual(1)
  })
})
