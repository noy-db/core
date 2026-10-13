/**
 * family#162 — a read FAILURE must not be read as an ABSENCE.
 *
 * ⛔ THE COMPOUND DEFECT. `assertKeyringOpenAllowed` is fail-closed: it refuses
 * to self-provision into a vault held by other principals, and it decides
 * "genuinely-new vault" from `list(vault, '_keyring')` returning empty. The
 * store contract says `[]` means "not there" — but `to-file` answered EVERY
 * read error with the absent value (`null` from `get`, `[]` from `list`, `{}`
 * from `loadAll`), so an EACCES on the vault directory made the gate read a
 * populated vault as a new one and hub provisioned a second owner into it.
 *
 * ⚠️ Two halves with two owners. The store half is `to-file`'s (fixed in the
 * same PR, with its own cases). THIS file covers hub's half, which is narrower
 * and worth stating exactly: hub cannot verify a `[]` — there is no second
 * question a wrongly-answering store would answer differently — so what hub
 * owes is to NOT SWALLOW a store that does throw. That is what these cases
 * assert, and it is the only part of the duty hub can hold.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/index.js'

const SECRET = 'pw-absence-162'

/** Seed a real vault, then fail one read method the way a filesystem would. */
async function seededThenFailing(
  fail: (inner: NoydbStore) => Partial<NoydbStore>,
): Promise<NoydbStore> {
  const inner = memoryStore()
  const db = await createNoydb({ store: inner, user: 'alice', secret: SECRET })
  const vault = await db.openVault('acme')
  await vault.collection<{ id: string }>('rows').put('r1', { id: 'r1' })
  await db.close()
  return { ...inner, ...fail(inner) } as NoydbStore
}

const eacces = (): Error => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

describe('family#162 — hub must not swallow a store that reports a failure', () => {
  it('⛔ a throwing list() does NOT become a self-provisioned second owner', async () => {
    // THE CASE. Before to-file was fixed its `list` returned `[]` here, the
    // gate read "new vault", and `bob` was provisioned into alice's vault.
    const store = await seededThenFailing((inner) => ({
      list: async (v: string, c: string) => {
        if (c === '_keyring') throw eacces()
        return inner.list(v, c)
      },
    }))
    const bob = await createNoydb({ store, user: 'bob', secret: 'pw-bob-162' })
    await expect(
      bob.openVault('acme'),
      'hub swallowed a failed keyring listing and self-provisioned',
    ).rejects.toThrow(/EACCES/)
  })

  it('⛔ a throwing get() on the keyring row propagates, it does not create', async () => {
    const store = await seededThenFailing((inner) => ({
      get: async (v: string, c: string, id: string) => {
        if (c === '_keyring') throw eacces()
        return inner.get(v, c, id)
      },
    }))
    const alice = await createNoydb({ store, user: 'alice', secret: SECRET })
    await expect(alice.openVault('acme')).rejects.toThrow(/EACCES/)
  })

  it('the genuine ABSENCE path still provisions — the control', async () => {
    // Without this, a fix that refused every open would satisfy both cases
    // above. An empty store IS a new vault, and first boot must still work.
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: SECRET })
    const vault = await db.openVault('brand-new')
    await vault.collection<{ id: string }>('rows').put('r1', { id: 'r1' })
    expect((await vault.collection<{ id: string }>('rows').get('r1'))?.id).toBe('r1')
    await db.close()
  })

  it('a populated vault still refuses a stranger — the gate itself', async () => {
    // The property the gate exists for, with an honest store. Asserted here so
    // the cases above are about the FAILURE path and not about the gate.
    const inner = memoryStore()
    const db = await createNoydb({ store: inner, user: 'alice', secret: SECRET })
    await db.openVault('acme')
    await db.close()

    const bob = await createNoydb({ store: inner, user: 'bob', secret: 'pw-bob-162' })
    await expect(bob.openVault('acme')).rejects.toThrow(/self-provision|not opened/)
  })
})
