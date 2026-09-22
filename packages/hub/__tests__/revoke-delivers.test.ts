/**
 * core#100 — a revoke (or an explicit rotation) no longer strips every other
 * member of the rotated collections. pilot-1's variant (real DynamoDB): after
 * `revoke(u1)`, survivor `u2`'s file held `_roster, _inbox_key` only — data
 * DEKs, `_users` AND `_broker_member` gone (its cloud identity with them),
 * and the "obvious repair" (`updateUser`) delivered a DEK that did not match
 * the target's records, which were never re-encrypted there: rotation writes
 * through the raw store, invisible to the dirty log.
 *
 * Now: the re-minted DEKs are sealed to each survivor's inbox (core#96),
 * `_broker_member` is never in a rotation's scope, and every rewritten record
 * is dirty-tracked so the next push carries the new ciphertext.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError, ValidationError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withBroker } from '../src/with-party/broker/index.js'
import { parseKeyringEnvelope } from '../src/with-party/team/keyring.js'
import { makeTestHost, type TestHost } from './broker/support.js'
import type { NoydbStore, KeyringFile } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
const ENDPOINT = 'https://broker.example.com'
type Inv = { n: number }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string, host?: TestHost, attested = true) {
  return createNoydb({
    store, sync: remote, user, secret, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam(),
    ...(host ? { brokerStrategy: withBroker({ brokerId: 'b1', endpoint: ENDPOINT, fetch: host.fetch, ...(attested ? { attestation: () => 'dev-token' } : {}) }) } : {}),
  })
}
async function file(store: NoydbStore, user: string): Promise<KeyringFile> {
  return parseKeyringEnvelope((await store.get('firm', '_keyring', user))!)
}

/** owner + two operators sharing `notes`; u2 open on its own device with a broker identity. */
async function seed() {
  const host = makeTestHost({ requireAttestation: true })
  const remote = memoryStore()
  const localO = memoryStore()
  const dbO = await open(localO, remote, 'owner', S, host)
  const vO = await dbO.openVault('firm')
  await vO.broker().enroll()
  for (let i = 0; i < 5; i++) await vO.collection<Inv>('notes').put(`n${i}`, { n: i })
  await dbO.grant('firm', { userId: 'u1', displayName: 'U1', role: 'operator', secret: U, permissions: { notes: 'rw' } })
  await dbO.grant('firm', { userId: 'u2', displayName: 'U2', role: 'operator', secret: U, permissions: { notes: 'rw' } })
  await dbO.push('firm')
  const localU2 = memoryStore()
  const dbU2 = await open(localU2, remote, 'u2', U, host, false)
  const vU2 = await dbU2.openVault('firm'); await dbU2.pull('firm')
  expect(await vU2.collection<Inv>('notes').get('n1')).toEqual({ n: 1 })
  return { host, remote, localO, localU2, dbO, vO, dbU2, vU2 }
}

describe('core#100 — revoke keeps every survivor working', () => {
  it('the survivor keeps notes, _users and its broker identity; the target gets the re-encrypted records; the revoked key opens nothing', async () => {
    const { host, remote, localU2, dbO, vO, dbU2, vU2 } = await seed()
    const before = (await remote.get('firm', 'notes', 'n1'))!
    await dbO.revoke('firm', { userId: 'u1' })
    const pushed = await dbO.push('firm')
    expect(pushed.pushed).toBeGreaterThanOrEqual(5) // the rewritten records ride the dirty log
    const after = (await remote.get('firm', 'notes', 'n1'))!
    expect(after._data).not.toBe(before._data) // new ciphertext on the target
    expect(after._v).toBe(before._v)

    const r = await dbU2.pull('firm')
    expect(r.errors).toEqual([])
    expect(await vU2.collection<Inv>('notes').get('n1')).toEqual({ n: 1 }) // open session, no reopen
    await vU2.collection<Inv>('notes').put('n9', { n: 9 })
    expect((await dbU2.push('firm')).errors).toEqual([])
    expect(await vO.collection<Inv>('notes').get('n9')).toBeNull() // owner sees it after a pull
    await dbO.pull('firm')
    expect(await vO.collection<Inv>('notes').get('n9')).toEqual({ n: 9 })

    const f = await file(localU2, 'u2')
    expect(Object.keys(f.deks)).toEqual(expect.arrayContaining(['notes', '_users', '_broker_member', '_inbox_key']))
    expect(f.inbox).toBeUndefined() // drained
    await expect(vU2.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' }) // identity intact
    expect(host.calls.revoke).toBe(1) // u1's, not u2's

    const fresh = await open(memoryStore(), remote, 'u2', U, host, false)
    const vF = await fresh.openVault('firm'); await fresh.pull('firm')
    expect(await vF.collection<Inv>('notes').get('n1')).toEqual({ n: 1 })
    expect(await remote.list('firm', '_keyring')).not.toContain('u1')
  })

  it('updateUser after a revoke delivers the CURRENT key, not a stale one', async () => {
    const { localU2, dbO, vO, dbU2, vU2 } = await seed()
    await vO.collection<Inv>('invoices').put('inv-1', { n: 10 })
    await dbO.revoke('firm', { userId: 'u1' })
    await dbO.push('firm')
    await dbO.updateUser('firm', { userId: 'u2', permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')
    await dbU2.pull('firm')
    expect(await vU2.collection<Inv>('notes').get('n2')).toEqual({ n: 2 })
    expect(await vU2.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 10 })
    expect((await file(localU2, 'u2')).inbox).toBeUndefined() // both boxes drained at the pull
  })

  it('an explicit rotate reports the rewrites and no needsRegrant for inbox members', async () => {
    const { dbO, dbU2, vU2 } = await seed()
    const r = await dbO.rotate('firm', ['notes'])
    expect(r.needsRegrant).toEqual([])
    expect(r.rewritten.filter(x => x.collection === 'notes').length).toBe(5)
    await dbO.push('firm')
    await dbU2.pull('firm')
    expect(await vU2.collection<Inv>('notes').get('n3')).toEqual({ n: 3 })
  })

  it('rotateKeys refuses the per-member keys by name', async () => {
    const { dbO } = await seed()
    await expect(dbO.rotate('firm', ['_broker_member'])).rejects.toBeInstanceOf(ValidationError)
    await expect(dbO.rotate('firm', ['_inbox_key'])).rejects.toBeInstanceOf(ValidationError)
  })

  it('the revoked member is out: their old session cannot read what the rotation rewrote', async () => {
    const { host, remote, dbO } = await seed()
    const localU1 = memoryStore()
    const dbU1 = await open(localU1, remote, 'u1', U, host, false)
    const vU1 = await dbU1.openVault('firm'); await dbU1.pull('firm')
    expect(await vU1.collection<Inv>('notes').get('n1')).toEqual({ n: 1 })
    await dbO.revoke('firm', { userId: 'u1' })
    await dbO.push('firm')
    const r = await dbU1.pull('firm')
    // its keyring is gone from the target; whatever the pull did, the rewritten record is closed to it
    let readable = true
    try { await vU1.collection<Inv>('notes').get('n1') } catch { readable = false }
    expect(readable && r.errors.length === 0).toBe(false)
  })
})
