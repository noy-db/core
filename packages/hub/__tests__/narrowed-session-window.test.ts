/**
 * core#101 — what an ALREADY-OPEN session can still do after a narrowing.
 *
 * `updateUser` writes the target's keyring and cannot reach a session the
 * target already has open. The consumer building a long-lived admin console
 * asked the two questions a security reviewer asks, and REASONING WOULD HAVE
 * GOT BOTH WRONG in the cautious direction — the documented answer on
 * `Noydb.updateUser` is the measurement, and this file is the measurement.
 *
 * ⭐ Both properties are load-bearing for a consumer's ceremony (an
 * administrative narrowing needs a re-open; a security-motivated one needs a
 * rotate), so they are pinned rather than left as prose that could drift away
 * from the code it describes.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, NoAccessError } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
interface D { id: string; body: string }

const open = (store: NoydbStore, sync: NoydbStore, user: string, secret: string) =>
  createNoydb({ store, sync, user, secret, validateSecret: false, teamStrategy: withTeam(), syncStrategy: withSync() })

/** bob holds `extra`, opens, reads — then is narrowed away and the vault is re-keyed. */
async function narrowedAfterOpen() {
  const remote = memoryStore()
  const dbO = await open(memoryStore(), remote, 'owner', S)
  const vO = await dbO.openVault('v1')
  await vO.collection<D>('extra').put('e1', { id: 'e1', body: 'E1' })
  await dbO.grant('v1', { userId: 'bob', displayName: 'bob', role: 'operator', secret: U, permissions: { extra: 'rw' } })
  await dbO.push('v1')

  const dbB = await open(memoryStore(), remote, 'bob', U)
  const vB = await dbB.openVault('v1')
  await dbB.pull('v1')
  expect(await vB.collection<D>('extra').list()).toEqual([{ id: 'e1', body: 'E1' }])  // control

  await dbO.updateUser('v1', { userId: 'bob', permissions: {} })
  await dbO.rotate('v1', ['extra'])
  await vO.collection<D>('extra').put('e2', { id: 'e2', body: 'AFTER-NARROW' })
  await dbO.push('v1')
  return { remote, dbO, vO, dbB, vB }
}

describe('core#101 — the window a narrowing leaves open', () => {
  it('records written AFTER the narrowing are not readable, and the pull closes the window on the cached ones too', async () => {
    const { dbB, vB } = await narrowedAfterOpen()
    await dbB.pull('v1')

    await expect(vB.collection<D>('extra').get('e2')).rejects.toBeInstanceOf(NoAccessError)
    // ⭐ and the rows it had already cached stop reading as well: the pull
    // brought the new roster and the session reloaded its keyring. With sync
    // on, the window closes at the next pull rather than at re-open.
    await expect(vB.collection<D>('extra').list()).rejects.toBeInstanceOf(NoAccessError)
  })

  it('writes from the narrowed session are refused LOCALLY and never reach the remote', async () => {
    const { remote, dbB, vB } = await narrowedAfterOpen()
    await dbB.pull('v1')

    await expect(vB.collection<D>('extra').put('b1', { id: 'b1', body: 'BOB' })).rejects.toThrow()
    const pushed = await dbB.push('v1')
    expect(pushed.pushed).toBe(0)
    expect(await remote.get('v1', 'extra', 'b1')).toBeNull()

    // ⛔ the control that makes this mean something: a THIRD party's view.
    // Nothing reaches the remote to be judged, so this does not rest on the
    // admission gate — it never gets that far.
    const chk = await open(memoryStore(), remote, 'owner', S)
    const vC = await chk.openVault('v1')
    await chk.pull('v1')
    expect(await vC.collection<D>('extra').get('b1')).toBeNull()
  })
})
