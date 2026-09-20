/**
 * core#56 — the delegation READ half, and the multi-DEK collection-wide token.
 *
 * ## What was wrong
 *
 * `issueDelegation` and `revokeDelegation` were wired; `loadActiveDelegations`
 * was called by nothing. A token was written to `_delegations` and never
 * consumed, so `assertTierAccess`'s documented "via a prior grant or an active
 * delegation" had no implementation for its second clause.
 *
 * ## ⛔ Why collection-wide is a MAP of DEKs, not a wildcard
 *
 * Each collection has its own tier DEK — measured, `docs#1` and `ledger#1` are
 * different keys. The original design expressed "every collection" as one DEK
 * under a wildcard slot `__any#<tier>`, which cannot work: one key decrypts one
 * collection. Teaching the access gate to accept that slot would have passed the
 * check and then failed decryption — a gate that says yes followed by a crypto
 * error. `__any#` is gone. A collection-wide token now carries one wrapped DEK
 * PER COLLECTION, each merged under its real `<collection>#<tier>` slot, so
 * `assertTierAccess` needs no wildcard and gains no privilege surface.
 *
 * ## ⚠️ What these tests do NOT prove
 *
 * `delegate()` wraps against the GRANTOR's own KEK — its own comment calls that
 * "a simpler first cut" pending a per-target KEK exchange. So CROSS-USER
 * delegation still does not work, and no test here claims it does. What is
 * proven is the mechanism: a token is written, read back, unwrapped, merged
 * under real slots, and the merged key decrypts.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Doc { id: string; body: string }

function memoryStore(): NoydbStore {
  const d = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = d.get(v); if (!vm) { vm = new Map(); d.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return d.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, e, ev) {
      const co = gc(v, c); const ex = co.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      co.set(id, e)
    },
    async delete(v, c, id) { d.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(d.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = d.get(v); const s: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [i, e] of cm) r[i] = e
        s[cn] = r
      }
      return s
    },
    async saveAll() {},
  }
}

async function vaultWithTiers() {
  const db = await createNoydb({
    store: memoryStore(), secret: 'pw', user: 'owner',
    tiersStrategy: withTiers(), teamStrategy: withTeam(),
  })
  const vault = await db.openVault('v1')
  await vault.collection<Doc>('docs', { tiers: [0, 1] }).putAtTier('d', { id: 'd', body: 'D' }, 1)
  await vault.collection<Doc>('ledger', { tiers: [0, 1] }).putAtTier('l', { id: 'l', body: 'L' }, 1)
  return vault
}

const slots = (v: unknown): string[] =>
  [...(v as { keyring: { deks: Map<string, unknown> } }).keyring.deks.keys()]

const until = (): string => new Date(Date.now() + 60_000).toISOString()

describe('core#56 — the delegation read half', () => {
  it('refreshDelegations is side-effect-free when nothing is written (the control)', async () => {
    const vault = await vaultWithTiers()
    const before = slots(vault)
    expect(await vault.refreshDelegations()).toEqual([])
    expect(slots(vault)).toEqual(before)   // no DEK minted merely by reading
  })

  it('a per-collection token is read back and merged under its REAL slot', async () => {
    const vault = await vaultWithTiers()
    const token = await vault.delegate({ toUser: 'owner', tier: 1, collection: 'docs', until: until() })
    expect(token.wrappedDek).toBeTruthy()
    expect(token.wrappedDeks).toBeUndefined()

    const merged = await vault.refreshDelegations()
    expect(merged.map((t) => t.id)).toContain(token.id)
    expect(slots(vault)).toContain('docs#1')
    // ⛔ No wildcard slot is ever created.
    expect(slots(vault).some((k) => k.startsWith('__any#'))).toBe(false)
  })

  it('a collection-wide token carries one wrapped DEK PER COLLECTION', async () => {
    const vault = await vaultWithTiers()
    const token = await vault.delegate({ toUser: 'owner', tier: 1, until: until() })

    expect(token.collection).toBeNull()
    expect(token.wrappedDek).toBeUndefined()
    expect(Object.keys(token.wrappedDeks ?? {}).sort()).toEqual(['docs#1', 'ledger#1'])

    const merged = await vault.refreshDelegations()
    expect(merged.map((t) => t.id)).toContain(token.id)
    expect(slots(vault).some((k) => k.startsWith('__any#'))).toBe(false)
  })

  it('a merged delegated DEK actually DECRYPTS — and the test is not vacuous', async () => {
    const vault = await vaultWithTiers()
    const token = await vault.delegate({ toUser: 'owner', tier: 1, until: until() })

    // ⭐ NON-VACUITY. The issuer already holds `docs#1`, so a read here would
    // succeed with or without the delegation — the reason the original
    // `describe('delegation tokens')` block could assert nothing about access.
    // Drop the slot, prove the read is now refused, THEN refresh and prove the
    // delegated key restores it.
    const deks = (vault as unknown as { keyring: { deks: Map<string, unknown> } }).keyring.deks
    deks.delete('docs#1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    const cold = await docs.getAtTier('d').then((r) => r, () => null)
    expect((cold as Doc | null)?.body).not.toBe('D')

    const merged = await vault.refreshDelegations()
    expect(merged.map((t) => t.id)).toContain(token.id)
    expect([...deks.keys()]).toContain('docs#1')

    const warm = await docs.getAtTier('d')
    expect((warm as Doc | null)?.body).toBe('D')
  })

  it('an EXPIRED token is not merged', async () => {
    const vault = await vaultWithTiers()
    await vault.delegate({
      toUser: 'owner', tier: 1, collection: 'docs',
      until: new Date(Date.now() + 1_000).toISOString(),
    })
    // Same store, evaluated an hour later.
    const merged = await vault.refreshDelegations(new Date(Date.now() + 3_600_000))
    expect(merged).toEqual([])
  })

  it('a token addressed to somebody else is not merged', async () => {
    const vault = await vaultWithTiers()
    await vault.delegate({ toUser: 'someone-else', tier: 1, collection: 'docs', until: until() })
    expect(await vault.refreshDelegations()).toEqual([])
  })
})
