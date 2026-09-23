/**
 * core#101 — a collection the session holds no key for must FAIL, not read empty.
 *
 * pilot-1 (core#96 run): after a narrowing, `list()` returned 0 rows on one
 * collection and `NoAccessError` on another — one had been held and rotated
 * away, the other never held. An empty list on a collection the app knows has
 * rows is the silent wrong answer a consumer builds a bug on.
 *
 * ⭐ MEASURED ON `main` BEFORE WRITING THIS: both paths already throw. The
 * defect was fixed in passing by the core#96/#100/#102 keyring work, not by a
 * change aimed at it. So this file is a REGRESSION test, not a fix — and it
 * exists precisely because nothing else pins the property: the behaviour that
 * closed the issue was a side effect, and a side effect can be undone by the
 * next change to the same path without anybody noticing.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
interface D { id: string; body: string }

const open = (store: NoydbStore, user: string, secret: string) =>
  createNoydb({ store, user, secret, validateSecret: false, teamStrategy: withTeam() })

/** bob holds `invoices`; `extra` was granted then narrowed away; `never` he never held. */
async function firm() {
  const store = memoryStore()
  const dbO = await open(store, 'owner', S)
  const vO = await dbO.openVault('v1')
  await vO.collection<D>('extra').put('e1', { id: 'e1', body: 'E' })
  await vO.collection<D>('invoices').put('i1', { id: 'i1', body: 'I' })
  await vO.collection<D>('never').put('n1', { id: 'n1', body: 'N' })
  await dbO.grant('v1', { userId: 'bob', displayName: 'bob', role: 'operator', secret: U, permissions: { extra: 'rw', invoices: 'rw' } })
  await dbO.updateUser('v1', { userId: 'bob', permissions: { invoices: 'rw' } })
  return { store, dbO, vO }
}

describe('core#101 — no key is an error, never an empty read', () => {
  it('a collection narrowed away: list() and get() both throw, they do not read empty', async () => {
    const { store } = await firm()
    const bob = await (await open(store, 'bob', U)).openVault('v1')
    await expect(bob.collection<D>('extra').list()).rejects.toBeInstanceOf(NoAccessError)
    await expect(bob.collection<D>('extra').get('e1')).rejects.toBeInstanceOf(NoAccessError)
  })

  it('a collection never held: the same, by the same error class', async () => {
    const { store } = await firm()
    const bob = await (await open(store, 'bob', U)).openVault('v1')
    await expect(bob.collection<D>('never').list()).rejects.toBeInstanceOf(NoAccessError)
    await expect(bob.collection<D>('never').get('n1')).rejects.toBeInstanceOf(NoAccessError)
  })

  it('the control — a collection he DOES hold reads normally', async () => {
    // Without this the two rows above would pass just as well against a build
    // where every read throws, which is the other way to be uselessly safe.
    const { store } = await firm()
    const bob = await (await open(store, 'bob', U)).openVault('v1')
    expect(await bob.collection<D>('invoices').list()).toEqual([{ id: 'i1', body: 'I' }])
    expect(await bob.collection<D>('invoices').get('i1')).toEqual({ id: 'i1', body: 'I' })
  })

  it('⚠️ NOT covered, and deliberately: an already-open session is STALE, not fail-closed', async () => {
    // bob opens and hydrates while he still holds `extra`, then loses it. His
    // open session keeps serving the rows it cached. That is eager-mode cache
    // behaviour — the session does not poll — and is NOT what core#101 asked
    // for. Pinned here so the distinction is visible: a reader who finds this
    // surprising is looking at staleness, not at an access check.
    const { store, dbO, vO } = await firm()
    await dbO.updateUser('v1', { userId: 'bob', permissions: { extra: 'rw', invoices: 'rw' } })
    const bobDb = await open(store, 'bob', U)
    const bob = await bobDb.openVault('v1')
    expect(await bob.collection<D>('extra').list()).toEqual([{ id: 'e1', body: 'E' }])

    await dbO.updateUser('v1', { userId: 'bob', permissions: { invoices: 'rw' } })
    await dbO.rotate('v1', ['extra'])
    await vO.collection<D>('extra').put('e2', { id: 'e2', body: 'E2' })

    expect(await bob.collection<D>('extra').list()).toEqual([{ id: 'e1', body: 'E' }]) // stale cache
    const fresh = await (await open(store, 'bob', U)).openVault('v1')
    await expect(fresh.collection<D>('extra').list()).rejects.toBeInstanceOf(NoAccessError)
  })
})
