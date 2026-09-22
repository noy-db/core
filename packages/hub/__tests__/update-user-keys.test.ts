/**
 * core#96 — changing what an EXISTING member may do, without their secret.
 *
 * Before: `grant()` was the only way a DEK reached a member, and it re-keys
 * them from `options.secret`. After `acceptInvite` / `rotateSecret` the owner
 * does not hold that secret, and a re-grant with a stale one locked the member
 * out (measured — the first case below is that probe, now green through
 * `updateUser`). `updateUser` used to be a plaintext-header swap that could name
 * a collection the member had no key for.
 *
 * Now `updateUser` delivers the DEKs the member lacks through their keyring
 * INBOX — sealed to a per-member key pair whose private half only their KEK
 * reaches — and drops + rotates what they no longer qualify for.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError, MemberInboxMissingError, KeyringTamperedError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withBroker } from '../src/with-party/broker/index.js'
import { rotateSecret } from '../src/with-party/team/rotate-recover.js'
import { parseKeyringEnvelope, requireRosterKey } from '../src/with-party/team/keyring.js'
import { mintRosterTag, stampAuthority } from '../src/with-party/team/roster-tag.js'
import { makeTestHost, type TestHost } from './broker/support.js'
import type { NoydbStore, KeyringFile } from '../src/kernel/types.js'
import { INBOX_KEY_ID } from '../src/kernel/constants.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
const U2 = 'user-rotated-phrase-xyz'
type Inv = { n: number }
const ENDPOINT = 'https://broker.example.com'

function open(store: NoydbStore, remote: NoydbStore | undefined, user: string, secret: string, host?: TestHost, attested = true) {
  return createNoydb({
    store, ...(remote ? { sync: remote } : {}), user, secret, validateSecret: false,
    syncStrategy: withSync(), teamStrategy: withTeam(),
    ...(host ? { brokerStrategy: withBroker({ brokerId: 'b1', endpoint: ENDPOINT, fetch: host.fetch, ...(attested ? { attestation: () => 'dev-token' } : {}) }) } : {}),
  })
}
async function file(store: NoydbStore, user: string): Promise<KeyringFile> {
  return parseKeyringEnvelope((await store.get('firm', '_keyring', user))!)
}

/** owner grants u1 operator on `notes`; u1 rotates their phrase on their own device; both replicas in step. */
async function setup() {
  const remote = memoryStore()
  const localO = memoryStore()
  const dbO = await open(localO, remote, 'owner', S)
  const vO = await dbO.openVault('firm')
  await vO.collection<Inv>('notes').put('n1', { n: 1 })
  await vO.collection<Inv>('invoices').put('inv-1', { n: 10 })
  await vO.collection<Inv>('salaries').put('s1', { n: 100 })
  await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
  await dbO.push('firm')
  const localU = memoryStore()
  const dbU0 = await open(localU, remote, 'u1', U)
  await dbU0.openVault('firm'); await dbU0.pull('firm')
  await rotateSecret(localU, 'firm', 'u1', { oldSecret: U, newSecret: U2, allowWeakSecret: true })
  await dbU0.close()
  const dbU = await open(localU, remote, 'u1', U2)
  const vU = await dbU.openVault('firm'); await dbU.push('firm')
  await dbO.pull('firm')
  return { remote, localO, localU, dbO, vO, dbU, vU }
}

describe('core#96 — updateUser widens a member the owner holds no secret for', () => {
  it('the probe: member rotated their phrase; owner adds a collection; member reads it on a fresh device with the ROTATED phrase', async () => {
    const { remote, dbO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    const dbB = await open(memoryStore(), remote, 'u1', U2)
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await vB.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 })
    expect(await vB.collection<Inv>('notes').get('n1')).toEqual({ n: 1 })
    await expect(vB.collection<Inv>('salaries').get('s1')).rejects.toBeInstanceOf(NoAccessError)
  })

  it('the delivery rides the file: sealed inbox on the target, drained into the member\'s own deks after their tier-1 open, and the drained file supersedes on every replica', async () => {
    const { remote, localO, dbO, vO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    const delivered = await file(remote, 'u1')
    expect(delivered.inbox?.slots).toEqual(['invoices'])
    expect(Object.keys(delivered.deks)).not.toContain('invoices')
    expect(delivered.inbox_key?.pub).toBeTruthy()

    const localB = memoryStore()
    const dbB = await open(localB, remote, 'u1', U2)
    await dbB.openVault('firm'); await dbB.pull('firm')
    // the pull reloaded the keyring in session (core#82) → drained → re-persisted
    const drained = await file(localB, 'u1')
    expect(drained.inbox).toBeUndefined()
    expect(Object.keys(drained.deks)).toContain('invoices')
    expect(drained.roster_epoch).toBe(delivered.roster_epoch! + 1)
    await dbB.push('firm'); await dbO.pull('firm')
    expect((await file(localO, 'u1')).inbox).toBeUndefined()
    expect(await vO.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 }) // owner untouched
  })

  it('a member already open takes the widening at the next pull, no reopen', async () => {
    const { dbO, dbU, vU } = await setup()
    await expect(vU.collection<Inv>('invoices').get('inv-1')).rejects.toBeInstanceOf(NoAccessError)
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    await dbU.pull('firm')
    expect(await vU.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 })
  })

  it('a second widening before the first is drained re-seals the whole pending set', async () => {
    const { remote, dbO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw', salaries: 'ro' } })
    await dbO.push('firm')
    expect((await file(remote, 'u1')).inbox?.slots).toEqual(['invoices', 'salaries'])
    const dbB = await open(memoryStore(), remote, 'u1', U2)
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await vB.collection<Inv>('salaries').get('s1')).toEqual({ n: 100 })
    expect(await vB.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 })
  })

  it('a collection that does not exist yet is minted for the delivery (#1004 shape)', async () => {
    const { remote, dbO, vO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', later: 'rw' } })
    await vO.collection<Inv>('later').put('l1', { n: 7 })
    await dbO.push('firm')
    const dbB = await open(memoryStore(), remote, 'u1', U2)
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await vB.collection<Inv>('later').get('l1')).toEqual({ n: 7 })
  })

  it('a wrap-all role change delivers every collection', async () => {
    const { remote, dbO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', role: 'viewer' })
    await dbO.push('firm')
    const dbB = await open(memoryStore(), remote, 'u1', U2)
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await vB.collection<Inv>('salaries').get('s1')).toEqual({ n: 100 })
  })
})

describe('core#96 — narrowing drops and rotates, as a narrowing grant does (#1097)', () => {
  it('the removed collection is unreadable after pull, its records are re-keyed, the owner still reads them', async () => {
    const { localO, remote, dbO, vO, dbU, vU } = await setup()
    const before = (await localO.get('firm', 'notes', 'n1'))!
    await dbO.updateUser('firm', { userId: 'u1', permissions: {} })
    await dbO.push('firm')
    const after = (await localO.get('firm', 'notes', 'n1'))!
    expect(after._data).not.toBe(before._data) // rotated
    expect(await vO.collection<Inv>('notes').get('n1')).toEqual({ n: 1 })
    await dbU.pull('firm')
    await expect(vU.collection<Inv>('notes').get('n1')).rejects.toBeInstanceOf(NoAccessError)
    expect(Object.keys((await file(remote, 'u1')).deks)).not.toContain('notes')
  })

  it('a pending, undrained delivery that is narrowed away rotates too (revoke sees the slot names)', async () => {
    const { localO, dbO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    const before = (await localO.get('firm', 'invoices', 'inv-1'))!._data
    await dbO.revoke('firm', { userId: 'u1' })
    expect((await localO.get('firm', 'invoices', 'inv-1'))!._data).not.toBe(before)
  })
})

describe('core#96 — the box is the member\'s alone', () => {
  it('a store cannot swap the inbox public key or strip a pending delivery: the tag fails', async () => {
    const { remote, dbO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    const env = (await remote.get('firm', '_keyring', 'u1'))!
    const f = parseKeyringEnvelope(env)
    // strip the delivery
    const { inbox: _i, ...stripped } = f
    await remote.put('firm', '_keyring', 'u1', { ...env, _data: JSON.stringify(stripped) })
    const dbB = await open(memoryStore(), remote, 'u1', U2)
    await expect(dbB.openVault('firm')).rejects.toBeInstanceOf(KeyringTamperedError)
    // swap the public key for another member's
    await dbO.grant('firm', { userId: 'u2', displayName: 'X', role: 'operator', secret: U, permissions: {} })
    await dbO.push('firm')
    const other = await file(remote, 'u2')
    await remote.put('firm', '_keyring', 'u1', { ...env, _data: JSON.stringify({ ...f, inbox_key: other.inbox_key }) })
    const dbC = await open(memoryStore(), remote, 'u1', U2)
    await expect(dbC.openVault('firm')).rejects.toBeInstanceOf(KeyringTamperedError)
  })

  it('a member whose keyring predates inboxes gets MemberInboxMissingError, not a blind slot', async () => {
    const { localO, dbO, vO } = await setup()
    // forge the pre-core#96 shape with the owner's own roster key: no pair, no inbox slot, re-tagged
    const f = await file(localO, 'u1')
    const { inbox_key: _k, ...legacy } = f
    const deks = { ...legacy.deks }; delete deks[INBOX_KEY_ID]
    const { roster_tag: _t, ...authority } = { ...legacy, deks }
    const rosterKey = requireRosterKey((vO as unknown as { keyring: Parameters<typeof requireRosterKey>[0] }).keyring, 'test')
    const withEpoch = stampAuthority(authority, f.roster_epoch)
    const env = (await localO.get('firm', '_keyring', 'u1'))!
    await localO.put('firm', '_keyring', 'u1', { ...env, _data: JSON.stringify({ ...withEpoch, roster_tag: await mintRosterTag(withEpoch, rosterKey) }) })
    await expect(dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })).rejects.toBeInstanceOf(MemberInboxMissingError)
    // a header-only change still works on such a keyring
    await dbO.updateUser('firm', { userId: 'u1', displayName: 'Renamed' })
    expect((await file(localO, 'u1')).display_name).toBe('Renamed')
  })
})

describe('core#96 — a role change re-registers the member with the broker host', () => {
  it('operator → viewer: a fresh _broker_member DEK rides the inbox, the host holds the new role, the old session is told to reopen', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const remote = memoryStore()
    const dbO = await open(memoryStore(), remote, 'owner', S, host)
    const vO = await dbO.openVault('firm')
    await vO.broker().enroll()
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')
    const dbU = await open(memoryStore(), remote, 'u1', U, host, false)
    const vU = await dbU.openVault('firm'); await dbU.pull('firm')
    await expect(vU.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' })
    expect(host.calls.enroll).toBe(2) // admin + u1

    await dbO.updateUser('firm', { userId: 'u1', role: 'viewer' })
    expect(host.calls.enroll).toBe(3)
    await dbO.push('firm')
    // the still-open session keeps its cached credential until expiry; its next real mint is refused
    // by name (`BrokerEnrolmentError`, "replaced by a re-grant"), the path #91's stale-session case covers
    await dbU.pull('firm')
    const fresh = await open(memoryStore(), remote, 'u1', U, host, false)
    const vF = await fresh.openVault('firm'); await fresh.pull('firm')
    await expect(vF.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' })
    expect(host.member('firm', 'b1', 'u1')?.role).toBe('viewer')
  })

  it('operator → admin drops the member seed and de-registers with the host', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const remote = memoryStore()
    const dbO = await open(memoryStore(), remote, 'owner', S, host)
    const vO = await dbO.openVault('firm')
    await vO.broker().enroll()
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.updateUser('firm', { userId: 'u1', role: 'admin' })
    expect(host.calls.revoke).toBe(1)
    await dbO.push('firm')
    expect(await remote.list('firm', '_broker_member')).toEqual([])
    const dbU = await open(memoryStore(), remote, 'u1', U, host)
    const vU = await dbU.openVault('firm'); await dbU.pull('firm')
    await expect(vU.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' }) // shared admin seed
  })
})

describe('core#96 — peer recovery folds a pending delivery into the recovered file', () => {
  it('the recovered member holds the delivered collection directly', async () => {
    const { remote, dbO } = await setup()
    await dbO.updateUser('firm', { userId: 'u1', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.team.recoverUser('firm', { userId: 'u1', secret: 'temp-bridge-secret-1', allowWeakSecret: true })
    await dbO.push('firm')
    const f = await file(remote, 'u1')
    expect(f.inbox).toBeUndefined()
    expect(Object.keys(f.deks)).toEqual(expect.arrayContaining(['invoices', INBOX_KEY_ID]))
    const dbB = await open(memoryStore(), remote, 'u1', 'temp-bridge-secret-1')
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await vB.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 })
  })
})
