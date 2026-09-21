/**
 * core#75 — keyring replication through sync targets.
 *
 * The property: a `sync-peer` target is a FULL replica — a device that lost
 * its local store re-opens from the target with nothing but its secret, and a
 * granted user opens on their own device the same way. Before this landed,
 * `_keyring` was written by a raw store put outside the dirty log and never
 * reached any target; a fresh local minted a new owner keyring and every
 * pulled envelope was unreadable (measured on the issue: A and A2).
 *
 * Every case runs the REAL open path (`createNoydb` + `openVault` + a secret),
 * because the defect was in what `openVault` did on an empty store.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Inv = { n: number }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string) {
  return createNoydb({
    store, sync: remote, user, secret, validateSecret: false,
    syncStrategy: withSync(), teamStrategy: withTeam(),
  })
}

async function rosterEpoch(store: NoydbStore, user: string): Promise<number | undefined> {
  const env = await store.get('firm', '_keyring', user)
  return env?._data ? (JSON.parse(env._data) as { roster_epoch?: number }).roster_epoch : undefined
}

describe('core#75 — case A: single owner, local lost, sync-peer survives', () => {
  it('push carries the owner keyring to the target', async () => {
    const remote = memoryStore()
    const db = await open(memoryStore(), remote, 'owner', S)
    const v = await db.openVault('firm')
    await v.collection<Inv>('invoices').put('inv-1', { n: 1 })
    expect(await remote.list('firm', '_keyring')).toEqual([])
    await db.push('firm')
    expect(await remote.list('firm', '_keyring')).toEqual(['owner'])
  })

  it('a fresh local + the same target + the same secret reads what was pushed', async () => {
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    await vA.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await dbA.push('firm')
    const epochA = await rosterEpoch(remote, 'owner')

    const localB = memoryStore()
    const dbB = await open(localB, remote, 'owner', S)
    const vB = await dbB.openVault('firm')
    // The keyring was BOOTSTRAPPED, not minted: same epoch as the pushed file.
    expect(await rosterEpoch(localB, 'owner')).toBe(epochA)
    await dbB.pull('firm')
    expect(await vB.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 1 })
  })

  it('the wrong secret on a fresh local is refused, not silently minted over', async () => {
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S)
    await dbA.openVault('firm')
    await dbA.push('firm')

    const dbB = await open(memoryStore(), remote, 'owner', 'not the secret at all')
    await expect(dbB.openVault('firm')).rejects.toThrow()
    expect(await remote.list('firm', '_keyring')).toEqual(['owner']) // remote untouched
  })
})

describe('core#75 — case A2: owner + granted user, each on their own local', () => {
  async function seedTwoUsers() {
    const remote = memoryStore()
    const localO = memoryStore()
    const dbO = await open(localO, remote, 'owner', S)
    const vO = await dbO.openVault('firm')
    await vO.collection<Inv>('invoices').put('seed', { n: 0 })
    await dbO.grant('firm', { userId: 'u1', displayName: 'User', role: 'operator', secret: U, permissions: { invoices: 'rw' } })
    await dbO.push('firm')
    return { remote, localO, dbO, vO }
  }

  it('the grant reaches the target on push', async () => {
    const { remote } = await seedTwoUsers()
    expect((await remote.list('firm', '_keyring')).sort()).toEqual(['owner', 'u1'])
  })

  it('u1 opens on a fresh device, reads the owner record, writes, pushes; owner sees it', async () => {
    const { remote, dbO, vO } = await seedTwoUsers()
    const dbU = await open(memoryStore(), remote, 'u1', U)
    const vU = await dbU.openVault('firm')
    await dbU.pull('firm')
    expect(await vU.collection<Inv>('invoices').get('seed')).toEqual({ n: 0 })
    await vU.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await dbU.push('firm')
    await dbO.pull('firm')
    expect(await vO.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 1 })
  })

  it('owner loses local after u1 wrote inv-2: fresh local + target + secret sees inv-2', async () => {
    const { remote } = await seedTwoUsers()
    const dbU = await open(memoryStore(), remote, 'u1', U)
    const vU = await dbU.openVault('firm')
    await dbU.pull('firm')
    await vU.collection<Inv>('invoices').put('inv-2', { n: 2 })
    await dbU.push('firm')

    const dbO2 = await open(memoryStore(), remote, 'owner', S)
    const vO2 = await dbO2.openVault('firm')
    await dbO2.pull('firm')
    expect(await vO2.collection<Inv>('invoices').get('inv-2')).toEqual({ n: 2 })
    // and the whole roster came with it, not just the owner's file
    expect((await dbO2.listUsers('firm')).map(u => u.userId).sort()).toEqual(['owner', 'u1'])
  })

  it('a stranger with no keyring on the target is refused, never self-provisioned', async () => {
    const { remote } = await seedTwoUsers()
    const dbX = await open(memoryStore(), remote, 'stranger', 'some-other-secret')
    await expect(dbX.openVault('firm')).rejects.toThrow(NoAccessError)
    expect((await remote.list('firm', '_keyring')).sort()).toEqual(['owner', 'u1'])
  })

  it('revoke propagates: the revoked file leaves the target on push and other devices on pull', async () => {
    const { remote, dbO } = await seedTwoUsers()
    const localB = memoryStore()
    const dbB = await open(localB, remote, 'owner', S)
    await dbB.openVault('firm')
    expect((await localB.list('firm', '_keyring')).sort()).toEqual(['owner', 'u1'])

    await dbO.revoke('firm', { userId: 'u1' })
    await dbO.push('firm')
    expect(await remote.list('firm', '_keyring')).toEqual(['owner'])
    await dbB.pull('firm')
    expect(await localB.list('firm', '_keyring')).toEqual(['owner'])
  })

  it('a stale copy never overwrites a newer file: higher roster_epoch wins in both directions', async () => {
    const { remote, dbO } = await seedTwoUsers()
    // device B holds u1 at the granted epoch
    const localB = memoryStore()
    const dbB = await open(localB, remote, 'owner', S)
    await dbB.openVault('firm')
    const before = await rosterEpoch(localB, 'u1')

    // owner narrows u1 (re-grant with a lower role bumps the epoch), pushes
    await dbO.grant('firm', { userId: 'u1', displayName: 'User', role: 'viewer', secret: U })
    await dbO.push('firm')
    const after = await rosterEpoch(remote, 'u1')
    expect(after!).toBeGreaterThan(before!)

    // B pushes its stale copy: remote keeps the newer file
    await dbB.push('firm')
    expect(await rosterEpoch(remote, 'u1')).toBe(after)
    // B pulls: local adopts the newer file
    await dbB.pull('firm')
    expect(await rosterEpoch(localB, 'u1')).toBe(after)
  })

  it('a target that has never carried keyrings does not empty a local roster on pull', async () => {
    const remote = memoryStore()
    const localO = memoryStore()
    const dbO = await open(localO, remote, 'owner', S)
    const vO = await dbO.openVault('firm')
    await vO.collection<Inv>('invoices').put('seed', { n: 0 })
    await dbO.grant('firm', { userId: 'u1', displayName: 'User', role: 'operator', secret: U, permissions: { invoices: 'rw' } })
    // pull BEFORE any push: remote has no _keyring at all
    await dbO.pull('firm')
    expect((await localO.list('firm', '_keyring')).sort()).toEqual(['owner', 'u1'])
  })

  it('a backup target is never a bootstrap source', async () => {
    const remote = memoryStore()
    const dbA = await createNoydb({ store: memoryStore(), sync: { store: remote, role: 'backup' }, user: 'owner', secret: S, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam() })
    await dbA.openVault('firm')
    await dbA.push('firm')
    expect(await remote.list('firm', '_keyring')).toEqual(['owner']) // push still carries it (a backup must be restorable)

    const dbB = await createNoydb({ store: memoryStore(), sync: { store: remote, role: 'backup' }, user: 'owner', secret: S, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam() })
    const vB = await dbB.openVault('firm') // mints: a backup is push-only, it is not consulted on open
    expect(vB).toBeDefined()
  })
})
