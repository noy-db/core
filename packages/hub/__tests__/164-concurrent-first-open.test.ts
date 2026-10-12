/**
 * family#164 — two concurrent FIRST opens of the same vault.
 *
 * ⛔ WHAT ACTUALLY HAPPENED, measured before the fix: one caller got a raw
 * `ConflictError` — `Version conflict: expected 0, found 1` — straight out of
 * `openVault`. `writeKeyringFile` CASes a create at `expectedVersion: 0`
 * (core#134), so the second create was correctly REFUSED; nothing caught the
 * refusal.
 *
 * ⚠️ The vault stayed openable afterwards, so this is an unhandled race rather
 * than corruption. That distinction matters for how a caller experiences it: one
 * that retries succeeds, one that does not treats the vault as unopenable — and
 * the failure surfaces only under concurrency, in a code path every first boot
 * takes.
 *
 * ⛔ `Promise.all` ON TWO SEPARATE INSTANCES IS THE SHAPE THAT REPRODUCES IT.
 * `openVault` single-flights per name within ONE instance (#564), so two opens
 * on the same `Noydb` serialise and never race. Two processes — or two
 * instances over one store, which is what this simulates — do.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/index.js'
import { ConflictError } from '../src/index.js'

const SECRET = 'pw-concurrent-164'

/** A store whose CAS is ADVISORY — a read, a yield, then the write. */
function nonAtomicCas(): NoydbStore {
  const inner = memoryStore()
  return {
    ...inner,
    capabilities: { casAtomic: false },
    async put(v: string, c: string, id: string, env: EncryptedEnvelope, ev?: number) {
      if (ev !== undefined) {
        const current = await inner.get(v, c, id)
        await new Promise((r) => setTimeout(r, 5)) // the window a real fs/http store has
        if ((current?._v ?? 0) !== ev) throw new ConflictError(current?._v ?? 0)
      }
      return inner.put(v, c, id, env)
    },
  } as NoydbStore
}

const opener = (store: NoydbStore) => async () =>
  await createNoydb({ store, user: 'alice', secret: SECRET })

describe('family#164 — concurrent first opens', () => {
  it('⭐ both concurrent first opens succeed', async () => {
    const open = opener(memoryStore())
    const [a, b] = await Promise.all([open(), open()])

    const results = await Promise.allSettled([a.openVault('acme'), b.openVault('acme')])
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason?.message),
      'a concurrent first open was refused — the create race is unhandled',
    ).toEqual([])

    await a.close(); await b.close()
  })

  it('both see the SAME keyring, so neither clobbered the other', async () => {
    // ⚠️ The half that matters more than "no throw". A fix that caught the
    // conflict and created a SECOND keyring would pass the case above while
    // orphaning the winner's collection DEKs — permanent unopenability, which
    // is the failure mode this issue is named for.
    const store = memoryStore()
    const open = opener(store)
    const [a, b] = await Promise.all([open(), open()])
    const [va, vb] = await Promise.all([a.openVault('acme'), b.openVault('acme')])

    await va.collection<{ id: string; n: number }>('rows').put('r1', { id: 'r1', n: 1 })
    // If b holds a different keyring, this read fails or returns nothing.
    expect((await vb.collection<{ id: string; n: number }>('rows').get('r1'))?.n).toBe(1)

    await a.close(); await b.close()
  })

  it('the vault reopens cleanly in a fresh session afterwards', async () => {
    const store = memoryStore()
    const open = opener(store)
    const [a, b] = await Promise.all([open(), open()])
    await Promise.all([a.openVault('acme'), b.openVault('acme')])
    await a.close(); await b.close()

    const c = await open()
    const v = await c.openVault('acme')
    await v.collection<{ id: string }>('rows').put('r1', { id: 'r1' })
    expect((await v.collection<{ id: string }>('rows').get('r1'))?.id).toBe('r1')
    await c.close()
  })

  it('holds on a store whose CAS is only ADVISORY', async () => {
    // ⚠️ Not the residual case — see `createOwnerKeyringOrLoad`'s note. This
    // asserts the HANDLING is store-agnostic: the loser loads whether the
    // refusal came from an atomic CAS or an advisory one.
    const open = opener(nonAtomicCas())
    const [a, b] = await Promise.all([open(), open()])
    const results = await Promise.allSettled([a.openVault('acme'), b.openVault('acme')])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    await a.close(); await b.close()
  })

  it('a NON-conflict failure from the create still propagates', async () => {
    // The control. Swallowing every error from the create would make this
    // "fix" hide a real write failure as a silent load attempt.
    const inner = memoryStore()
    const hostile = {
      ...inner,
      async put(v: string, c: string, id: string, env: EncryptedEnvelope) {
        if (c === '_keyring') throw new Error('disk on fire')
        return inner.put(v, c, id, env)
      },
    } as NoydbStore
    const db = await createNoydb({ store: hostile, user: 'alice', secret: SECRET })
    await expect(db.openVault('acme')).rejects.toThrow(/disk on fire/)
  })
})
