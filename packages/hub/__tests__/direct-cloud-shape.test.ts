/**
 * pilot-1's direct cloud shape — local store + a `sync-peer` target reached
 * with broker-minted credentials — trialled against real DynamoDB + STS
 * (core#67) and reported as five gaps in front of the member's own device:
 *
 *  - core#91: `_broker` / `_broker_member` did not replicate, so a member
 *    could mint only on the device where it was granted (and an admin only
 *    where it enrolled).
 *  - core#94: `_users/<id>` outlived `revoke()` on the target.
 *  - core#92: records written before a target existed were never pushed —
 *    `push({ full: true })`.
 *  - core#93 (engine half): push was one serial put per record —
 *    `push({ concurrency })`.
 *  - core#90: `sync` was construction-only — `attachSyncTarget()`.
 *  - and a papercut: a corrupted `_data` surfaced as a raw DOMException.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, DecryptionError, TamperedError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withBroker } from '../src/with-party/broker/index.js'
import { makeTestHost, type TestHost } from './broker/support.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Inv = { n: number }
const ENDPOINT = 'https://broker.example.com'

function brokered(host: TestHost, attested = true) {
  return withBroker({ brokerId: 'b1', endpoint: ENDPOINT, fetch: host.fetch, ...(attested ? { attestation: () => 'dev-token' } : {}) })
}
function open(store: NoydbStore, remote: NoydbStore | undefined, user: string, secret: string, host?: TestHost, attested = true) {
  return createNoydb({
    store, ...(remote ? { sync: remote } : {}), user, secret, validateSecret: false,
    syncStrategy: withSync(), teamStrategy: withTeam(), ...(host ? { brokerStrategy: brokered(host, attested) } : {}),
  })
}

describe('core#91 — broker seeds replicate: a member mints on its own device, an admin on a fresh one', () => {
  it('_broker_member reaches the target on push; a member on a fresh device mints after pull', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const remote = memoryStore()
    const dbO = await open(memoryStore(), remote, 'owner', S, host)
    const vO = await dbO.openVault('firm')
    await vO.broker().enroll()
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')
    expect(await remote.list('firm', '_broker_member')).toEqual(['u1'])
    expect(await remote.list('firm', '_broker')).toEqual(['b1'])

    const dbU = await open(memoryStore(), remote, 'u1', U, host, false)
    const vU = await dbU.openVault('firm')
    await dbU.pull('firm')
    await expect(vU.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' })
  })

  it('an admin on a fresh device mints without enrolling again', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S, host)
    const vA = await dbA.openVault('firm')
    await vA.broker().enroll()
    await dbA.push('firm')
    const dbB = await open(memoryStore(), remote, 'owner', S, host)
    const vB = await dbB.openVault('firm')
    await dbB.pull('firm')
    await expect(vB.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' })
    expect(host.calls.enroll).toBe(1)
  })

  it('revoke removes the member record on the target and on other devices', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const remote = memoryStore()
    const dbO = await open(memoryStore(), remote, 'owner', S, host)
    const vO = await dbO.openVault('firm')
    await vO.broker().enroll()
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')
    const localB = memoryStore()
    const dbB = await open(localB, remote, 'owner', S, host)
    await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await localB.list('firm', '_broker_member')).toEqual(['u1'])
    await dbO.revoke('firm', { userId: 'u1' })
    await dbO.push('firm')
    expect(await remote.list('firm', '_broker_member')).toEqual([])
    await dbB.pull('firm')
    expect(await localB.list('firm', '_broker_member')).toEqual([])
  })
})

describe('core#94 — _users/<id> does not outlive revoke', () => {
  it('the user envelope leaves the local store on revoke and the target on push', async () => {
    const remote = memoryStore()
    const localO = memoryStore()
    const dbO = await open(localO, remote, 'owner', S)
    await dbO.openVault('firm')
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')
    expect(await remote.list('firm', '_users')).toContain('u1')
    await dbO.revoke('firm', { userId: 'u1' })
    expect(await localO.list('firm', '_users')).not.toContain('u1')
    await dbO.push('firm')
    expect(await remote.list('firm', '_users')).not.toContain('u1')
  })
})

describe('core#92 — push({ full: true }): everything local is authoritative, send it', () => {
  it('records written before any target existed are pushed by a full push, and a plain push still sends nothing stale', async () => {
    const local = memoryStore()
    const remote = memoryStore()
    const db0 = await open(local, undefined, 'owner', S)
    const v0 = await db0.openVault('firm')
    for (let i = 0; i < 10; i++) await v0.collection<Inv>('invoices').put(`inv-${i}`, { n: i })
    await db0.close()

    const db1 = await open(local, remote, 'owner', S)
    await db1.openVault('firm')
    expect((await db1.push('firm')).pushed).toBe(0) // the trap, still true for a plain push
    const full = await db1.push('firm', { full: true })
    expect(full.pushed).toBe(10)
    expect((await remote.list('firm', 'invoices')).length).toBe(10)
    expect((await db1.push('firm')).pushed).toBe(0) // nothing left dirty
  })
})

describe('core#93 — push({ concurrency }): bounded parallel puts, same outcome', () => {
  it('60 records with concurrency 8 land identically to a serial push, and a CAS conflict still resolves', async () => {
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    for (let i = 0; i < 60; i++) await vA.collection<Inv>('invoices').put(`inv-${i}`, { n: i })
    const r = await dbA.push('firm', { concurrency: 8 })
    expect(r).toMatchObject({ pushed: 60, errors: [] })
    expect((await remote.list('firm', 'invoices')).length).toBe(60)

    // conflict: B advances inv-1 on the remote; A edits inv-1 locally and pushes 8-wide
    const dbB = await open(memoryStore(), remote, 'owner', S)
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    await vB.collection<Inv>('invoices').put('inv-1', { n: 100 }); await dbB.push('firm')
    await vA.collection<Inv>('invoices').put('inv-1', { n: 200 })
    for (let i = 60; i < 70; i++) await vA.collection<Inv>('invoices').put(`inv-${i}`, { n: i })
    const r2 = await dbA.push('firm', { concurrency: 8 })
    expect(r2.errors).toEqual([])
    expect(r2.conflicts.length).toBe(1)
    expect(dbA.syncTargetStatus('firm')[0]!.dirty).toBe(0)
  })
})

describe('core#90 — attachSyncTarget(): a target after open, no reconstruct', () => {
  it('attach, full push, then ordinary dirty tracking and pull work on the attached target', async () => {
    const remote = memoryStore()
    const db = await open(memoryStore(), undefined, 'owner', S)
    const v = await db.openVault('firm')
    await v.collection<Inv>('invoices').put('inv-1', { n: 1 })
    expect(db.syncTargetStatus('firm')).toEqual([])

    await db.attachSyncTarget('firm', { store: remote, role: 'sync-peer', label: 'cloud' })
    expect(db.syncTargetStatus('firm').map(t => t.label)).toEqual(['cloud'])
    expect((await db.push('firm', { full: true })).pushed).toBe(1)

    await v.collection<Inv>('invoices').put('inv-2', { n: 2 }) // written AFTER attach: dirty-tracked without a full push
    expect((await db.push('firm')).pushed).toBe(1)
    expect((await remote.list('firm', 'invoices')).sort()).toEqual(['inv-1', 'inv-2'])

    const dbB = await open(memoryStore(), remote, 'owner', S)
    const vB = await dbB.openVault('firm'); await dbB.pull('firm')
    expect(await vB.collection<Inv>('invoices').get('inv-2')).toEqual({ n: 2 })
  })

  it('a second attach is a second target, keyed by position', async () => {
    const db = await open(memoryStore(), undefined, 'owner', S)
    await db.openVault('firm')
    await db.attachSyncTarget('firm', { store: memoryStore(), role: 'sync-peer', label: 'a' })
    await db.attachSyncTarget('firm', { store: memoryStore(), role: 'backup', label: 'b' })
    expect(db.syncTargetStatus('firm').map(t => `${t.label}:${t.role}`)).toEqual(['a:sync-peer', 'b:backup'])
  })
})

describe('papercut — a corrupted body is a named error, never a raw DOMException', () => {
  it('garbage in _data reads as DecryptionError or TamperedError', async () => {
    const local = memoryStore()
    const db = await open(local, undefined, 'owner', S)
    const v = await db.openVault('firm')
    await v.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await db.close()
    const env = (await local.get('firm', 'invoices', 'inv-1'))!
    await local.put('firm', 'invoices', 'inv-1', { ...env, _data: '!!!not-base64!!!' })
    const db2 = await open(local, undefined, 'owner', S)
    const v2 = await db2.openVault('firm')
    let caught: unknown
    try { await v2.collection<Inv>('invoices').get('inv-1') } catch (e) { caught = e }
    expect(caught instanceof DecryptionError || caught instanceof TamperedError, String(caught)).toBe(true)
  })
})
