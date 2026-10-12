/**
 * family#95 — a managed `openVault` refused for missing strong recovery must
 * leave the store EMPTY.
 *
 * Measured before the fix: it wrote three documents and then refused —
 * `_meta/sealed-secret`, `_keyring/<user>`, `_meta/policy` — because
 * `#openVaultFresh` called `_getKeyringInternal` and `bootstrapPolicy` first
 * and `assertRecoveryEnrolled` only afterwards.
 *
 * ⭐ The managed branch of `assertRecoveryEnrolled` reads the STORE and never
 * touches the `policy` argument, so there was never a reason for it to run
 * after the policy is persisted. Hoisting it needs no new escape hatch:
 * `openVaultAndEnrollRecovery` already brackets its open with
 * `setSkipNextManagedRecoveryCheck`, which is honoured here too.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/index.js'
import { createNoydb, MemorySealer } from '../src/index.js'
import { ConflictError, ManagedRecoveryNotEnrolledError } from '../src/kernel/errors.js'
import { shamirRecoveryProvider } from './support/shamir-provider.js'

/** Records every write so the assertion names what leaked, not just that something did. */
function recordingMemory(writes: string[]): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    async get(v, c, id) { return gc(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) {
      writes.push(`${v}/${c}/${id}`)
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { gc(v, c).delete(id) },
    async list(v, c) { return [...gc(v, c).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
  }
}

describe('family#95 — a refused managed open is atomic', () => {
  it('writes NOTHING when strong recovery is missing', async () => {
    const writes: string[] = []
    const store = recordingMemory(writes)
    const db = await createNoydb({
      store, user: 'alice', secretMode: 'managed', sealingKey: new MemorySealer({ id: 'f95-a' }),
    })

    await expect(db.openVault('acme')).rejects.toBeInstanceOf(ManagedRecoveryNotEnrolledError)

    expect(writes).toEqual([])
    expect(await store.list('acme', '_meta')).toEqual([])
  })

  it('control: the bootstrap path still creates the vault, so the refusal is not blocking the fix', async () => {
    // Without this, "writes nothing" could be satisfied by a check that refuses
    // every managed open — including the one that is meant to succeed.
    const writes: string[] = []
    const store = recordingMemory(writes)
    const db = await createNoydb({
      store, user: 'alice', secretMode: 'managed', sealingKey: new MemorySealer({ id: 'f95-b' }),
      shamirRecovery: shamirRecoveryProvider(),
    })

    const r = await db.team.openVaultAndEnrollRecovery('acme', { recovery: [{ profile: 'shamir', k: 2, n: 3 }] })

    expect(r.recoveryEnrollments[0]!.shares).toHaveLength(3)
    expect(writes).toContain('acme/_meta/sealed-secret')
  })

  it('control: a plain managed open succeeds once recovery is on disk', async () => {
    const store = recordingMemory([])
    const sealer = new MemorySealer({ id: 'f95-c' })
    const db1 = await createNoydb({
      store, user: 'alice', secretMode: 'managed', sealingKey: sealer,
      shamirRecovery: shamirRecoveryProvider(),
    })
    await db1.team.openVaultAndEnrollRecovery('acme', { recovery: [{ profile: 'shamir', k: 2, n: 3 }] })

    const db2 = await createNoydb({ store, user: 'alice', secretMode: 'managed', sealingKey: sealer })
    await expect(db2.openVault('acme')).resolves.toBeDefined()
  })
})
