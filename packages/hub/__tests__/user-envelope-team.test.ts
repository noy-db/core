/**
 * Team-service integration for user envelopes (#23).
 *
 * Verifies the joined enumeration `listUsersWithEnvelopes()` returns
 * keyring summaries paired with their decrypted user envelopes — the
 * canonical "render team-member list with profile data" path for
 * admin UIs.
 *
 * Presence `displayName`: NOW TESTED, at the bottom of this file.
 *
 * History, because it is the point. This file used to end with a
 * describe block whose only assertion was `expect(true).toBe(true)`,
 * carrying the pattern below as a comment. It measured nothing, and its
 * own prose had gone stale unnoticed — it named `team/presence.ts`,
 * which does not exist; presence lives at `src/with-sync/presence.ts`.
 * It was demoted to prose here, with a note saying a real test would
 * need a two-client sync harness. It needed about sixty lines.
 *
 * THE PATTERN, now executed rather than described: presence takes a
 * generic payload `P`, so apps read
 * `vault.user.me<MyShape>().data.profile.displayName` and put it INTO
 * the payload they publish. Hub does not introspect the user envelope
 * to populate presence and stays payload-agnostic.
 *
 * ⚠️ The second presence test is the load-bearing one. A test showing a
 * displayName arrive is equally consistent with hub having fetched it
 * from the envelope itself, which is precisely the design decision
 * being pinned — so the control holds the envelope constant and drops
 * the name from the PAYLOAD, and requires it not to appear.
 *
 * @see design-history/2026-05-05-user-envelope-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { listUsersWithEnvelopes } from '../src/with-party/team/keyring.js'
import { USER_ENVELOPE_COLLECTION } from '../src/kernel/constants.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withSync } from '../src/with-sync/index.js'

interface TestProfile {
  profile?: { displayName?: string; locale?: string }
  preferences?: { theme?: 'light' | 'dark' }
}

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'inline-memory',
    async get(c: string, col: string, id: string) { return gc(c, col).get(id) },
    async put(c: string, col: string, id: string, env: EncryptedEnvelope) { gc(c, col).set(id, env) },
    async delete(c: string, col: string, id: string) { gc(c, col).delete(id) },
    async list(c: string, col: string) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

describe('team integration — listUsersWithEnvelopes (#23)', () => {
  let store: NoydbStore
  let aliceDb: Noydb

  beforeEach(async () => {
    store = inlineMemory()
    aliceDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const v = await aliceDb.openVault('demo')
    await v.user.updateMe<TestProfile>({
      profile: { displayName: 'Alice', locale: 'en-US' },
      preferences: { theme: 'dark' },
    })
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      secret: 'bob-pass-2026-strong',
      permissions: { invoices: 'rw' },
      initialProfile: {
        profile: { displayName: 'Bob the Auditor', locale: 'fr-FR' },
        preferences: { theme: 'light' },
      } satisfies TestProfile,
    })
    await aliceDb.grant('demo', {
      userId: 'carol',
      displayName: 'Carol',
      role: 'viewer',
      secret: 'carol-pass-2026-strong',
      // No initialProfile — empty seed envelope.
    })
  })

  it('returns one row per keyring, each paired with its envelope', async () => {
    const v = await aliceDb.openVault('demo')
    // Get the _users DEK by reading my own envelope first (caches the
    // DEK in the keyring). Then use the same DEK to read all envelopes.
    const me = await v.user.me<TestProfile>()
    expect(me).not.toBeNull()
    // Reach into the vault's lazy DEK resolver — public API doesn't
    // expose this, but tests can import the helper directly.
    const dek = await (v as unknown as {
      getDEK: (c: string) => Promise<CryptoKey>
    }).getDEK(USER_ENVELOPE_COLLECTION)

    const rows = await listUsersWithEnvelopes<TestProfile>(store, 'demo', dek, 'owner')
    expect(rows.length).toBe(3)

    const byId = new Map(rows.map((r) => [r.user.userId, r]))
    expect(byId.get('alice')!.envelope!.data.profile?.displayName).toBe('Alice')
    expect(byId.get('alice')!.user.role).toBe('owner')

    expect(byId.get('bob')!.envelope!.data.profile?.displayName).toBe('Bob the Auditor')
    expect(byId.get('bob')!.user.role).toBe('operator')

    // Carol has the empty seed envelope (data === {}).
    expect(byId.get('carol')!.envelope!.data).toEqual({})
    expect(byId.get('carol')!.user.role).toBe('viewer')
  })

  it('returns envelope: null for keyrings predating the user-envelope feature', async () => {
    // Simulate a "legacy" keyring by deleting the auto-created envelope
    // from the store after grant (mimicking a vault written before
    // this feature landed).
    await store.delete('demo', USER_ENVELOPE_COLLECTION, 'carol')

    const v = await aliceDb.openVault('demo')
    const dek = await (v as unknown as {
      getDEK: (c: string) => Promise<CryptoKey>
    }).getDEK(USER_ENVELOPE_COLLECTION)

    const rows = await listUsersWithEnvelopes<TestProfile>(store, 'demo', dek, 'owner')
    const carol = rows.find((r) => r.user.userId === 'carol')!
    expect(carol.envelope).toBeNull()
    // The keyring info is still present so the caller can fall back
    // to the keyring's display_name.
    expect(carol.user.displayName).toBe('Carol')
  })
})

/**
 * The envelope -> presence hop (#23), asserted rather than described.
 *
 * ⭐ THE SECOND TEST IS THE ONE THAT PROVES THE CLAIM. "Apps put displayName
 * in their presence payload" is only interesting because hub does NOT put it
 * there — a test that merely shows a displayName arriving is equally
 * consistent with hub introspecting the user envelope and populating presence
 * itself, which is the exact design decision being pinned. So the control is a
 * peer whose envelope HAS a displayName and whose payload OMITS it: if hub
 * introspected, it would surface anyway.
 */
interface RosterPayload { displayName?: string | undefined; editing: string }

describe('team integration — presence carries envelope-sourced displayName (#23)', () => {
  const SECRET_A = 'alice-pass-2026-strong'
  const SECRET_B = 'bob-pass-2026-strong'
  const COMP = 'demo'

  async function pair() {
    const store = inlineMemory()
    const aliceDb = await createNoydb({
      teamStrategy: withTeam(), syncStrategy: withSync(),
      store, user: 'alice', secret: SECRET_A,
    })
    const vA = await aliceDb.openVault(COMP)
    // Touch the collection so it has a DEK before granting access to it.
    await vA.collection('invoices').put('seed', { id: 'seed' })
    await aliceDb.grant(COMP, {
      userId: 'bob', displayName: 'Bob', role: 'operator', secret: SECRET_B,
      permissions: { invoices: 'rw' },
      initialProfile: {
        profile: { displayName: 'Bob the Auditor', locale: 'fr-FR' },
      } satisfies TestProfile,
    })
    const bobDb = await createNoydb({
      teamStrategy: withTeam(), syncStrategy: withSync(),
      store, user: 'bob', secret: SECRET_B,
    })
    const vB = await bobDb.openVault(COMP)
    return { vA, vB }
  }

  it('an app sources displayName from its own envelope and it reaches a peer', async () => {
    const { vA, vB } = await pair()

    // The documented app-side flow, executed rather than described: read my own
    // envelope, then put the name INTO the payload I publish.
    const me = await vB.user.me<TestProfile>()
    const myName = me?.data.profile?.displayName
    expect(myName).toBe('Bob the Auditor')

    const handleB = vB.collection<Record<string, unknown>>('invoices').presence<RosterPayload>()
    const handleA = vA.collection<Record<string, unknown>>('invoices')
      .presence<RosterPayload>({ pollIntervalMs: 50 })

    await handleB.update({ displayName: myName, editing: 'inv-42' })

    const seen: Array<{ userId: string; payload: RosterPayload }> = []
    handleA.subscribe((peers) => { seen.push(...peers) })
    await new Promise((r) => setTimeout(r, 200))

    const bob = seen.find((p) => p.userId === 'bob')
    expect(bob, 'alice should see bob as a peer').toBeDefined()
    expect(bob!.payload.displayName).toBe('Bob the Auditor')
    expect(bob!.payload.editing).toBe('inv-42')

    handleA.stop(); handleB.stop()
  })

  it('⭐ hub does NOT source it: the same envelope, omitted from the payload, does not appear', async () => {
    const { vA, vB } = await pair()

    // Bob's envelope still carries 'Bob the Auditor' — unchanged from the case
    // above. The ONLY difference is that his payload does not carry it.
    const me = await vB.user.me<TestProfile>()
    expect(me?.data.profile?.displayName).toBe('Bob the Auditor')

    const handleB = vB.collection<Record<string, unknown>>('invoices').presence<RosterPayload>()
    const handleA = vA.collection<Record<string, unknown>>('invoices')
      .presence<RosterPayload>({ pollIntervalMs: 50 })

    await handleB.update({ editing: 'inv-42' })

    const seen: Array<{ userId: string; payload: RosterPayload }> = []
    handleA.subscribe((peers) => { seen.push(...peers) })
    await new Promise((r) => setTimeout(r, 200))

    const bob = seen.find((p) => p.userId === 'bob')
    // Bob is present — so this is not passing because presence failed.
    expect(bob, 'alice should still see bob as a peer').toBeDefined()
    expect(bob!.payload.editing).toBe('inv-42')
    // ...and hub did not reach into his envelope to fill the gap.
    expect(bob!.payload.displayName).toBeUndefined()

    handleA.stop(); handleB.stop()
  })
})
