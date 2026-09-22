/**
 * Milestone "Hot replica" — the pieces after core#75.
 *
 *  - core#83 / core#82(2): reserved-record replication. `_keyring` was the
 *    first reserved collection to travel through a sync target; this is the
 *    DECLARED set that follows it (invite audit docs, user envelopes,
 *    delegations) and the two that deliberately do not (`_history`,
 *    `_ledger` — per-device evidence) plus the `_meta` session state that
 *    must never travel (`schema-fence`, `handle`).
 *  - core#82(3): a change to the caller's OWN keyring file pulled while the
 *    vault is open takes effect without a reopen.
 *  - core#81: `sync:progress` during pull and push, and `inFlight` on
 *    `syncTargetStatus()`.
 *  - core#82(1): `db.realign(vault)` — a corrupted LOCAL record is replaced
 *    from the survivor instead of winning on `_v`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { buildRecordEnvelope } from '../src/capsule/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore, EncryptedEnvelope, SyncProgress } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Inv = { n: number }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string) {
  return createNoydb({ store, sync: remote, user, secret, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam() })
}

/** A raw reserved-record envelope, the shape a satellite writes with `store.put` (plaintext body, like the invite audit doc). */
function rawDoc(collection: string, id: string, version: number, body: unknown): EncryptedEnvelope {
  return buildRecordEnvelope({ collection, id, version }, { iv: '', data: JSON.stringify(body) })
}

describe('core#83 / core#82 — reserved-record replication, declared not blanket', () => {
  it('an invite audit doc written raw on the issuer reaches the target on push and a fresh device on pull', async () => {
    const remote = memoryStore()
    const localO = memoryStore()
    const dbO = await open(localO, remote, 'owner', S)
    await dbO.openVault('firm')
    await localO.put('firm', '_meta', 'invite-audit-tok1', rawDoc('_meta', 'invite-audit-tok1', 1, { tokenId: 'tok1' }))
    await dbO.push('firm')
    expect(await remote.list('firm', '_meta')).toEqual(['invite-audit-tok1'])

    const localB = memoryStore()
    const dbB = await open(localB, remote, 'owner', S)
    await dbB.openVault('firm')
    await dbB.pull('firm')
    expect(await localB.list('firm', '_meta')).toContain('invite-audit-tok1')
  })

  it('_meta session state never travels: schema-fence and handle stay on the device', async () => {
    const remote = memoryStore()
    const localO = memoryStore()
    const dbO = await open(localO, remote, 'owner', S)
    await dbO.openVault('firm')
    await localO.put('firm', '_meta', 'schema-fence', rawDoc('_meta', 'schema-fence', 1, { state: 'draining' }))
    await localO.put('firm', '_meta', 'handle', rawDoc('_meta', 'handle', 1, { handle: 'x' }))
    await dbO.push('firm')
    expect(await remote.list('firm', '_meta')).toEqual([])
  })

  it('a newer _users envelope wins on _v in both directions; an equal one is a no-op', async () => {
    const remote = memoryStore()
    const localA = memoryStore(); const localB = memoryStore()
    const dbA = await open(localA, remote, 'owner', S); await dbA.openVault('firm')
    const dbB = await open(localB, remote, 'owner', S); await dbB.openVault('firm')
    await localA.put('firm', '_users', 'owner', rawDoc('_users', 'owner', 1, { v: 1 }))
    await dbA.push('firm')
    await dbB.pull('firm')
    expect((await localB.get('firm', '_users', 'owner'))?._v).toBe(1)
    await localB.put('firm', '_users', 'owner', rawDoc('_users', 'owner', 2, { v: 2 }))
    await dbB.push('firm')
    await localA.put('firm', '_users', 'owner', rawDoc('_users', 'owner', 1, { v: 'stale' }))
    await dbA.push('firm') // stale copy must not overwrite
    expect((await remote.get('firm', '_users', 'owner'))?._v).toBe(2)
    await dbA.pull('firm')
    expect((await localA.get('firm', '_users', 'owner'))?._v).toBe(2)
  })

  it('a delegation replicates, and its revocation (delete) propagates on pull once pushed', async () => {
    const remote = memoryStore()
    const localA = memoryStore(); const localB = memoryStore()
    const dbA = await open(localA, remote, 'owner', S); const vA = await dbA.openVault('firm')
    const dbB = await open(localB, remote, 'owner', S); await dbB.openVault('firm')
    await localA.put('firm', '_delegations', 'd1', rawDoc('_delegations', 'd1', 1, { to: 'u1' }))
    await localA.put('firm', '_delegations', 'd2', rawDoc('_delegations', 'd2', 1, { to: 'u2' }))
    await dbA.push('firm'); await dbB.pull('firm')
    expect((await localB.list('firm', '_delegations')).sort()).toEqual(['d1', 'd2'])
    await vA.revokeDelegation('d1') // the real revocation: a raw delete that now rides the dirty log
    await dbA.push('firm')
    expect(await remote.list('firm', '_delegations')).toEqual(['d2'])
    await dbB.pull('firm')
    expect(await localB.list('firm', '_delegations')).toEqual(['d2'])
  })

  it('_history and _ledger are per-device evidence and do not travel', async () => {
    const remote = memoryStore()
    const localO = memoryStore()
    const dbO = await open(localO, remote, 'owner', S)
    const v = await dbO.openVault('firm')
    await v.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await localO.put('firm', '_history', 'invoices:inv-1:0001', rawDoc('_history', 'invoices:inv-1:0001', 1, { n: 1 }))
    await dbO.push('firm')
    expect(await remote.list('firm', '_history')).toEqual([])
    expect(await remote.list('firm', '_ledger')).toEqual([])
  })
})

describe('core#82(3) — a pulled change to my own keyring takes effect without a reopen', () => {
  it('a re-grant that widens permissions is readable after pull, in the same session', async () => {
    const remote = memoryStore()
    const localO = memoryStore()
    const dbO = await open(localO, remote, 'owner', S)
    const vO = await dbO.openVault('firm')
    await vO.collection<Inv>('notes').put('n1', { n: 1 })
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')

    const dbU = await open(memoryStore(), remote, 'u1', U)
    const vU = await dbU.openVault('firm')
    await dbU.pull('firm')
    expect(await vU.collection<Inv>('notes').get('n1')).toEqual({ n: 1 })

    // owner creates a NEW collection and widens u1 to it — the only way a new DEK reaches u1 is a re-grant
    await vO.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw', invoices: 'rw' } })
    await dbO.push('firm')

    // Before this landed the pull brought the record but not the key: NoAccessError, until a reopen.
    await dbU.pull('firm')
    expect(await vU.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 1 }) // same session, no reopen
  })
})

describe('core#81 — progress while a sync runs', () => {
  it('pull emits sync:progress with a monotonic record count and a total, then sync:pull', async () => {
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    for (let i = 0; i < 120; i++) await vA.collection<Inv>('invoices').put(`inv-${i}`, { n: i })
    await dbA.push('firm')

    const dbB = await open(memoryStore(), remote, 'owner', S)
    await dbB.openVault('firm')
    const events: SyncProgress[] = []
    dbB.on('sync:progress', (p) => { events.push(p) })
    const result = await dbB.pull('firm')
    expect(result.pulled).toBe(120)
    expect(events.length).toBeGreaterThan(1)
    expect(events.every(e => e.direction === 'pull')).toBe(true)
    for (let i = 1; i < events.length; i++) expect(events[i]!.records).toBeGreaterThanOrEqual(events[i - 1]!.records)
    expect(events.at(-1)!.records).toBe(120)
    expect(events.at(-1)!.total?.records).toBe(120)
    expect(events.at(-1)!.bytes).toBeGreaterThan(0)
    expect(dbB.syncTargetStatus('firm')[0]!.inFlight).toBeUndefined() // nothing in flight after
  })

  it('push emits sync:progress with total = dirty entries', async () => {
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    for (let i = 0; i < 60; i++) await vA.collection<Inv>('invoices').put(`inv-${i}`, { n: i })
    const events: SyncProgress[] = []
    dbA.on('sync:progress', (p) => { events.push(p) })
    await dbA.push('firm')
    expect(events.at(-1)).toMatchObject({ direction: 'push', records: 60, total: { records: 60 } })
  })
})

describe('core#82(1) — realign a corrupted local from the survivor', () => {
  it('a damaged local envelope is replaced by the target copy, and the dirty log no longer carries it', async () => {
    const remote = memoryStore()
    const localA = memoryStore()
    const dbA = await open(localA, remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    await vA.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await vA.collection<Inv>('invoices').put('inv-2', { n: 2 })
    await dbA.push('firm')

    await dbA.close()

    // corrupt inv-1 in the local STORE: same _v, damaged body — before, this copy WINS on _v and is never repaired
    const good = (await localA.get('firm', 'invoices', 'inv-1'))!
    const bad = { ...good, _data: good._data!.slice(0, -4) + 'AAAA' }
    await localA.put('firm', 'invoices', 'inv-1', bad)
    const dbA2 = await open(localA, remote, 'owner', S) // a fresh session over the damaged store: no warm cache
    const vA2 = await dbA2.openVault('firm')
    await expect(vA2.collection<Inv>('invoices').get('inv-1')).rejects.toThrow()

    const r = await dbA2.realign('firm')
    expect(r).toMatchObject({ checked: 2, replaced: 1, unrecoverable: 0 })
    expect(await vA2.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 1 })
    expect(dbA2.syncTargetStatus('firm')[0]!.dirty).toBe(0)
  })

  it('core#100 — an ordinary pull repairs it too now: same _v, different bytes, no pending write → the target copy is adopted', async () => {
    const remote = memoryStore()
    const localA = memoryStore()
    const dbA = await open(localA, remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    await vA.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await dbA.push('firm')
    await dbA.close()
    const good = (await localA.get('firm', 'invoices', 'inv-1'))!
    await localA.put('firm', 'invoices', 'inv-1', { ...good, _data: good._data!.slice(0, -4) + 'AAAA' })
    const dbA2 = await open(localA, remote, 'owner', S)
    const vA2 = await dbA2.openVault('firm')
    await expect(vA2.collection<Inv>('invoices').get('inv-1')).rejects.toThrow()
    expect((await dbA2.pull('firm')).pulled).toBe(1)
    expect(await vA2.collection<Inv>('invoices').get('inv-1')).toEqual({ n: 1 })
  })
})

describe('core#81 — paged pull: bounded memory, a total before the first apply', () => {
  async function seeded(n: number) {
    const remote = memoryStore()
    const dbA = await open(memoryStore(), remote, 'owner', S)
    const vA = await dbA.openVault('firm')
    for (let i = 0; i < n; i++) await vA.collection<Inv>('invoices').put(`inv-${i}`, { n: i })
    for (let i = 0; i < 30; i++) await vA.collection<Inv>('notes').put(`n-${i}`, { n: i })
    await dbA.push('firm')
    return { remote, dbA }
  }

  it('pull({ paged: true }) over a listPage store converges like a full pull and knows the total from the first records sample', async () => {
    const { remote } = await seeded(250)
    const dbB = await open(memoryStore(), remote, 'owner', S)
    const vB = await dbB.openVault('firm')
    const events: SyncProgress[] = []
    dbB.on('sync:progress', (p) => { events.push(p) })
    const r = await dbB.pull('firm', { paged: true })
    expect(r.pulled).toBe(280)
    expect(await vB.collection<Inv>('invoices').get('inv-249')).toEqual({ n: 249 })
    const first = events.find(e => e.phase === 'records')!
    expect(first.total?.records).toBe(280)
    expect(events.at(-1)!.records).toBe(280)
  })

  it('pull({ paged: true }) over a store WITHOUT listPage still converges (list + get fallback)', async () => {
    const { remote } = await seeded(120)
    const { listPage: _drop, ...noPage } = remote as NoydbStore & { listPage?: unknown }
    const dbB = await open(memoryStore(), noPage as NoydbStore, 'owner', S)
    const vB = await dbB.openVault('firm')
    const r = await dbB.pull('firm', { paged: true })
    expect(r.pulled).toBe(150)
    expect(await vB.collection<Inv>('notes').get('n-29')).toEqual({ n: 29 })
  })

  it('scope, stated: paged mode walks the collections this keyring names — a member with no key for a collection does not pull it', async () => {
    const remote = memoryStore()
    const dbO = await open(memoryStore(), remote, 'owner', S)
    const vO = await dbO.openVault('firm')
    await vO.collection<Inv>('invoices').put('inv-1', { n: 1 })
    await vO.collection<Inv>('notes').put('n-1', { n: 1 })
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { notes: 'rw' } })
    await dbO.push('firm')

    const localU = memoryStore()
    const dbU = await open(localU, remote, 'u1', U)
    await dbU.openVault('firm')
    await dbU.pull('firm', { paged: true })
    expect(await localU.list('firm', 'notes')).toEqual(['n-1'])
    expect(await localU.list('firm', 'invoices')).toEqual([]) // a full pull would carry the ciphertext; paged mode cannot enumerate it
  })
})
