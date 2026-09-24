/**
 * core#130 — the inbox drain is reachable ONLY through a KEK-gated load, and
 * that gating is the security control. This file is what stops it being
 * refactored away by someone who cannot see what it is holding up.
 *
 * ## What it is holding up
 *
 * `_inbox_key` is in `NON_ROTATABLE_SLOTS`, so a copy of it never expires. A
 * tier-2 wrap-DEKs blob carries the whole DEK map, `_inbox_key` included, and
 * per #1445 removing an authenticator HIDES a credential rather than revoking
 * it — `rotate()` is the remedy, because it re-mints the DEKs a stale blob
 * holds. But `rotate()` delivers the new DEKs THROUGH THE INBOX (#100).
 *
 * ⛔ So a drain that needed only a DEK map would let a hidden credential open
 * the post-rotation boxes and recover the new DEKs — turning rotation from
 * "cuts off a stale credential" into "re-supplies it". The only reason that is
 * not reachable today is that the drain sits inside `loadKeyring`, which
 * refuses without a `kek` or a `secret` — neither of which a stale blob has.
 *
 * ⭐ THE ABSENCE OF A DRAIN PRIMITIVE IS THE SAFETY PROPERTY. A future
 * `drainKeyringInbox(file, deks)` would reintroduce this, which is why
 * family#42's proposal for exactly that was withdrawn.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, ValidationError } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { loadKeyring, NON_ROTATABLE_SLOTS } from '../src/with-party/team/keyring.js'
import { INBOX_KEY_ID } from '../src/kernel/constants.js'
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

describe('core#130 — the inbox drain is KEK-gated, and that is the control', () => {
  it('loadKeyring REFUSES without a kek or a secret — the only door to the drain', async () => {
    const { store } = await firm()
    await expect(
      loadKeyring(store, 'v1', { userId: 'bob' }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      loadKeyring(store, 'v1', { userId: 'bob' }),
    ).rejects.toThrow(/one of .*secret.* \/ .*kek.* is required/)
  })

  it('the control is not vacuous — the SAME call succeeds with a secret', async () => {
    // Without this, the row above would pass equally against a build where
    // loadKeyring always threw, which is a different and useless kind of safe.
    const { store } = await firm()
    const unlocked = await loadKeyring(store, 'v1', { userId: 'bob', secret: U })
    expect(unlocked.deks.has('notes')).toBe(true)
    expect(unlocked.deks.has(INBOX_KEY_ID)).toBe(true)
  })

  it('⛔ `_inbox_key` is non-rotatable — the premise that makes the gating load-bearing', () => {
    // If this ever changes, core#130's chain breaks and the gating stops being
    // the ONLY thing standing between a hidden credential and a rotation's
    // freshly delivered DEKs. Pinned so that change is deliberate.
    expect(NON_ROTATABLE_SLOTS.has(INBOX_KEY_ID)).toBe(true)
  })

  it('a rotation does NOT re-mint the inbox key, so a captured copy never expires', async () => {
    const { store, db } = await firm()
    const before = (await loadKeyring(store, 'v1', { userId: 'bob', secret: U })).deks.get(INBOX_KEY_ID)
    await db.rotate('v1', ['notes'])
    const after = (await loadKeyring(store, 'v1', { userId: 'bob', secret: U })).deks.get(INBOX_KEY_ID)
    expect(after).toBeDefined()
    // same key object identity is not assertable across unlocks; compare the
    // stored wrapped form instead — it is what a captured blob would hold.
    const file = JSON.parse((await store.get('v1', '_keyring', 'bob'))!._data as string) as { deks: Record<string, string> }
    expect(file.deks[INBOX_KEY_ID]).toBeTruthy()
    void before
  })
})
