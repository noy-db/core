/**
 * core#73 — member-scoped broker credentials.
 *
 * Before this: the broker seed was one key per vault, usable by owner/admin
 * only (role gate + the `_broker` DEK withheld from every sub-admin grantee),
 * and the proof carried no identity, so the host could not tell users apart,
 * let alone scope by role. A member device had no way to obtain cloud-store
 * credentials at all.
 *
 * After: `grant()` mints a per-grantee `_broker_member` DEK, and — when a
 * broker is configured — the kernel enrols the member: a per-member seed,
 * encrypted under that DEK, registered with the host as
 * `{ userId, role, proofKey }`. The member proves with canonical v2
 * (userId + role inside the MAC); `revoke()` de-registers. Re-grant
 * re-enrols with the new role.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withTeam } from '../../src/with-party/team/index.js'
import { withBroker } from '../../src/with-party/broker/index.js'
import { BrokerEnrolmentError, ReservedCollectionNameError } from '../../src/kernel/errors.js'
import { loadKeyring } from '../../src/with-party/team/keyring.js'
import { BROKER_COLLECTION, BROKER_MEMBER_COLLECTION } from '../../src/with-party/team/reserved-secret-collections.js'
import { memoryStore, makeTestHost, type TestHost } from './support.js'

const VAULT = 'T-member'
const ENDPOINT = 'https://broker.example.com'

async function ownerDb(adapter = memoryStore(), host: TestHost = makeTestHost({ requireAttestation: true })) {
  const db = await createNoydb({
    store: adapter, user: 'owner-01', secret: 'owner-pass',
    teamStrategy: withTeam(),
    brokerStrategy: withBroker({ brokerId: 'broker-1', endpoint: ENDPOINT, attestation: () => 'dev-token', fetch: host.fetch }),
  })
  const vault = await db.openVault(VAULT)
  await vault.broker().enroll()
  return { db, vault, adapter, host }
}

async function memberDb(adapter: ReturnType<typeof memoryStore>, host: TestHost, userId: string, secret: string) {
  const db = await createNoydb({
    store: adapter, user: userId, secret,
    teamStrategy: withTeam(),
    brokerStrategy: withBroker({ brokerId: 'broker-1', endpoint: ENDPOINT, fetch: host.fetch }),
  })
  return { db, vault: await db.openVault(VAULT) }
}

describe('core#73 — grant enrols a member with the broker host', () => {
  it('grant(operator) registers { userId, role } with the host and writes the member record', async () => {
    const { db, adapter, host } = await ownerDb()
    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })

    expect(host.member(VAULT, 'broker-1', 'op1')?.role).toBe('operator')
    expect(await adapter.list(VAULT, BROKER_MEMBER_COLLECTION)).toEqual(['op1'])

    const op = await loadKeyring(adapter, VAULT, { userId: 'op1', secret: 'op-pass-long' })
    expect(op.deks.has(BROKER_MEMBER_COLLECTION)).toBe(true)
    expect(op.deks.has(BROKER_COLLECTION)).toBe(false) // the shared admin seed stays withheld
    const owner = await loadKeyring(adapter, VAULT, { userId: 'owner-01', secret: 'owner-pass' })
    expect(owner.deks.has(BROKER_MEMBER_COLLECTION)).toBe(false) // per-grantee, never the grantor's
    await db.close()
  })

  it('every role below admin is enrolled; an admin grantee is not (it uses the shared seed)', async () => {
    const { db, host } = await ownerDb()
    for (const [userId, role] of [['v1', 'viewer'], ['c1', 'client'], ['k1', 'custodian'], ['a1', 'admin']] as const) {
      await db.grant(VAULT, { userId, displayName: userId, role, secret: `${userId}-pass-long`, ...(role === 'client' ? { permissions: { notes: 'rw' } } : {}) })
    }
    expect(host.member(VAULT, 'broker-1', 'v1')?.role).toBe('viewer')
    expect(host.member(VAULT, 'broker-1', 'c1')?.role).toBe('client')
    expect(host.member(VAULT, 'broker-1', 'k1')?.role).toBe('custodian')
    expect(host.member(VAULT, 'broker-1', 'a1')).toBeUndefined()
    await db.close()
  })

  it('grant still works with no broker configured (NO_BROKER is a no-op, not a throw)', async () => {
    const adapter = memoryStore()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass', teamStrategy: withTeam() })
    await db.openVault(VAULT)
    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })
    expect(await adapter.list(VAULT, BROKER_MEMBER_COLLECTION)).toEqual([])
    await db.close()
  })

  it('the member record is never reachable through vault.collection()', async () => {
    const { db, vault } = await ownerDb()
    expect(() => vault.collection(BROKER_MEMBER_COLLECTION)).toThrow(ReservedCollectionNameError)
    await db.close()
  })
})

describe('core#73 — a member mints its own credentials', () => {
  it('credentialSource() on a member keyring proves with userId + role and gets role-scoped credentials', async () => {
    const host = makeTestHost({
      requireAttestation: true,
      credentials: (vaultId, brokerId, member) => ({ kind: 'token', token: `${vaultId}/${brokerId}/${member?.userId ?? 'admin'}/${member?.role ?? 'admin'}` }),
    })
    const { db, adapter } = await ownerDb(memoryStore(), host)
    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })
    await db.close()

    const m = await memberDb(adapter, host, 'op1', 'op-pass-long')
    const creds = await m.vault.broker().credentialSource('read')()
    expect(creds).toEqual({ kind: 'token', token: `${VAULT}/broker-1/op1/operator` })
    expect(host.calls.credentials).toBe(1)
    await m.db.close()
  })

  it('a member keyring without a member enrolment fails with a named error, not the admin gate', async () => {
    // A keyring granted BEFORE a broker was enrolled: the DEK exists (grant always mints it)
    // but no record was written and nothing was registered.
    const adapter = memoryStore()
    const plain = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass', teamStrategy: withTeam() })
    await plain.openVault(VAULT)
    await plain.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })
    await plain.close()

    const host = makeTestHost()
    const m = await memberDb(adapter, host, 'op1', 'op-pass-long')
    await expect(m.vault.broker().credentialSource()()).rejects.toThrow(BrokerEnrolmentError)
    await expect(m.vault.broker().credentialSource()()).rejects.toThrow(/re-grant/)
    await m.db.close()
  })

  it('a member cannot enroll() or rotate() the shared seed', async () => {
    const { db, adapter, host } = await ownerDb()
    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })
    await db.close()
    const m = await memberDb(adapter, host, 'op1', 'op-pass-long')
    await expect(m.vault.broker().enroll()).rejects.toThrow(/owner or admin/)
    await expect(m.vault.broker().rotate()).rejects.toThrow(/owner or admin/)
    await m.db.close()
  })
})

describe('core#73 — lifecycle', () => {
  it('re-grant with a narrower role re-registers: new key, new role, the old key no longer verifies', async () => {
    const { db, adapter, host } = await ownerDb()
    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })
    const before = host.member(VAULT, 'broker-1', 'op1')!
    // a member device still holding the OLD enrolment
    const stale = await memberDb(adapter, host, 'op1', 'op-pass-long')

    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'viewer', secret: 'op-pass-long' })
    const after = host.member(VAULT, 'broker-1', 'op1')!
    expect(after.role).toBe('viewer')
    expect(after.proofKey).not.toBe(before.proofKey)

    // the stale session holds the OLD member DEK: the re-sealed record is unreadable to it — named, not TamperedError
    await expect(stale.vault.broker().credentialSource()()).rejects.toThrow(BrokerEnrolmentError)
    await expect(stale.vault.broker().credentialSource()()).rejects.toThrow(/re-grant/)
    const fresh = await memberDb(adapter, host, 'op1', 'op-pass-long')
    await expect(fresh.vault.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' })
    await stale.db.close(); await fresh.db.close(); await db.close()
  })

  it('revoke() de-registers the member and deletes the record; a stale device is refused', async () => {
    const { db, adapter, host } = await ownerDb()
    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })
    const stale = await memberDb(adapter, host, 'op1', 'op-pass-long')

    await db.revoke(VAULT, { userId: 'op1' })
    expect(host.member(VAULT, 'broker-1', 'op1')).toBeUndefined()
    expect(host.calls.revoke).toBe(1)
    expect(await adapter.list(VAULT, BROKER_MEMBER_COLLECTION)).toEqual([])

    await expect(stale.vault.broker().credentialSource()()).rejects.toThrow()
    await stale.db.close(); await db.close()
  })

  it('peer recovery re-enrols the member under a fresh key, and the recovered secret mints', async () => {
    const { db, adapter, host } = await ownerDb()
    await db.grant(VAULT, { userId: 'op1', displayName: 'Op', role: 'operator', secret: 'op-pass-long', permissions: { notes: 'rw' } })
    const before = host.member(VAULT, 'broker-1', 'op1')!
    await db.team.recoverUser(VAULT, { userId: 'op1', secret: 'temp-pass-long-enough' })
    const after = host.member(VAULT, 'broker-1', 'op1')!
    expect(after.role).toBe('operator')
    expect(after.proofKey).not.toBe(before.proofKey)
    const m = await memberDb(adapter, host, 'op1', 'temp-pass-long-enough')
    await expect(m.vault.broker().credentialSource()()).resolves.toMatchObject({ kind: 'aws' })
    await m.db.close(); await db.close()
  })

  it('the admin shared path is untouched: owner still mints with canonical v1 and no userId', async () => {
    const host = makeTestHost({ requireAttestation: true, credentials: (_v, _b, member) => ({ kind: 'token', token: member ? 'member' : 'admin' }) })
    const { db, vault } = await ownerDb(memoryStore(), host)
    await expect(vault.broker().credentialSource()()).resolves.toEqual({ kind: 'token', token: 'admin' })
    await db.close()
  })
})
