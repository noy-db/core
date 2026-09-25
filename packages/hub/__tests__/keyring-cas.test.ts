/**
 * core#132 — a keyring write CASes against the version it was computed from.
 *
 * `writeKeyringFile` ended in a bare `store.put` with no `expectedVersion`,
 * and every keyring envelope was pinned at `version: 1`, so there was nothing
 * to compare even if a caller had wanted to. Two concurrent edits to one
 * member's keyring were last-writer-wins, silently.
 *
 * ⭐ CREATES ARE PROTECTED TOO, since core#134 — `expectedVersion: 0`. The
 * original wording here said absence was INEXPRESSIBLE; that was wrong, and
 * measuring it is what closed the issue. Nothing hub writes starts below
 * version 1, so 0 is an exact "must not exist" on any store that compares only
 * when the record is present. It waited on `@noy-db/ports/to`'s absent case
 * rather than on a mechanism, because the one reading that could have broken it
 * — a native conditional-CAS store rejecting the FIRST create — is exactly what
 * a kit case forbids and a census cannot.
 *
 * ⛔ THE ONE LIMIT THAT STILL SHIPS: **mixed fleets get no protection.** An
 * older hub writes at `_v: 1` with no `expectedVersion`, so it clobbers a newer
 * hub's CAS — create or update — and resets the line. The guarantee is real
 * only once every writer is a new hub, which is why this is cut-gated rather
 * than a fix that rides any release.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, ConflictError } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { readKeyringFile, writeKeyringFile, basisOf } from '../src/with-party/team/keyring.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
interface D { id: string; body: string }

async function firm() {
  const store = memoryStore()
  const db = await createNoydb({ store, user: 'owner', secret: S, validateSecret: false, teamStrategy: withTeam() })
  const v = await db.openVault('v1')
  await v.collection<D>('notes').put('n1', { id: 'n1', body: 'N' })
  await db.grant('v1', { userId: 'bob', displayName: 'bob', role: 'operator', secret: U, permissions: { notes: 'rw' } })
  return { store, db, v }
}

describe('core#132 — keyring writes CAS on the version they were computed from', () => {
  it('the version LINE advances — it used to be pinned at 1 forever', async () => {
    const { store, db } = await firm()
    const first = (await readKeyringFile(store, 'v1', 'bob'))!.envelope._v
    await db.updateUser('v1', { userId: 'bob', displayName: 'bob 2' })
    const second = (await readKeyringFile(store, 'v1', 'bob'))!.envelope._v
    expect(second).toBeGreaterThan(first)
  })

  it('a write based on a STALE read is refused, where it used to clobber', async () => {
    const { store, db } = await firm()
    const stale = (await readKeyringFile(store, 'v1', 'bob'))!   // read…
    await db.updateUser('v1', { userId: 'bob', displayName: 'moved on' })  // …someone else writes

    await expect(
      writeKeyringFile(store, 'v1', 'bob', stale.file, basisOf(stale)),
    ).rejects.toBeInstanceOf(ConflictError)

    // ⭐ and the winner's edit SURVIVED — the point is not that the second
    // write fails, it is that the first one is still there afterwards.
    expect((await readKeyringFile(store, 'v1', 'bob'))!.file.display_name).toBe('moved on')
  })

  it('the control — a write based on a CURRENT read still succeeds', async () => {
    // Without this the row above passes equally against a build where every
    // keyring write throws, which is a different and useless kind of safe.
    const { store } = await firm()
    const fresh = (await readKeyringFile(store, 'v1', 'bob'))!
    await expect(writeKeyringFile(store, 'v1', 'bob', fresh.file, basisOf(fresh))).resolves.toBeUndefined()
  })

  it('a CREATE is protected too — the second create of one userId conflicts (core#134)', async () => {
    const { store } = await firm()
    const src = (await readKeyringFile(store, 'v1', 'bob'))!.file

    // The first create of an absent userId lands. ⭐ This half is the control,
    // and it is the half an adapter is most likely to get wrong: a backend
    // whose conditional write rejects a missing item would fail HERE, not
    // below. `@noy-db/ports/to` asserts both halves for exactly that reason.
    await writeKeyringFile(store, 'v1', 'newbie', src, 'create')
    expect((await readKeyringFile(store, 'v1', 'newbie'))!.envelope._v).toBe(1)

    // A second concurrent grant of the same NEW userId used to clobber the
    // first silently. It now conflicts, because what it believed absent is
    // present at _v 1.
    await expect(
      writeKeyringFile(store, 'v1', 'newbie', src, 'create'),
    ).rejects.toBeInstanceOf(ConflictError)

    // …and the first grant SURVIVED, which is the point rather than the throw.
    expect((await readKeyringFile(store, 'v1', 'newbie'))!.envelope._v).toBe(1)
  })

  it('ordinary admin flows still work end to end — rotate, updateUser, revoke', async () => {
    const { store, db } = await firm()
    await db.updateUser('v1', { userId: 'bob', permissions: { notes: 'ro' } })
    await db.rotate('v1', ['notes'])
    await db.revoke('v1', { userId: 'bob' })
    expect(await readKeyringFile(store, 'v1', 'bob')).toBeUndefined()
  })
})
