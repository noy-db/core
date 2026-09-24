/**
 * core#132 — two SESSIONS minting a DEK for the same new collection.
 *
 * ⛔ THIS IS A DATA-LOSS BUG ON `main`, not a hardening exercise. Measured
 * before the fix: both rows land in the store, ONE wrapped DEK is persisted,
 * each live session reads its OWN row, and a cold session reads NEITHER —
 * `TamperedError` on both, because each session encrypted under the key it
 * minted and only one of those keys survived in the keyring.
 *
 * ⭐⭐ THE SYMPTOM IS THE TAMPER ALARM FIRING ON THE USER'S OWN DATA, and that
 * is the severity, not the lost row. This project's central claim is that a
 * store cannot alter what it serves without being caught; `daemon#1` already
 * records a false positive on that alarm as "the failure that teaches users to
 * ignore the alarm". A reader who meets `TamperedError` from their own
 * uncorrupted records learns to discount it — and the next one is real.
 *
 * ⚠️ Reproduced independently against the PUBLISHED `@noy-db/hub@0.8.0`
 * tarball from public npm, so this was live on `@latest`, not a defect of an
 * unreleased tree.
 *
 * ⭐ It cannot be fixed without the CAS. Read-after-write was tried first and
 * fails: a loser can adopt the winner's key and then a LATER persist clobbers
 * it again, with the adopter none the wiser. One DEK per collection means
 * there is no merge either — you cannot keep both. The loser has to LEARN it
 * lost, which is what `expectedVersion` provides.
 *
 * ⚠️ `inFlight` in `ensureCollectionDEK` dedupes concurrent mints WITHIN one
 * session and is structurally blind to another session, so the single-session
 * control below passes on `main` too. That is why the control is here: it
 * proves the failure is about sessions, not about concurrency.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
interface D { id: string; body: string }
const open = (store: NoydbStore) =>
  createNoydb({ store, user: 'owner', secret: S, validateSecret: false, teamStrategy: withTeam() })

describe('core#132 — concurrent DEK mint across sessions', () => {
  it('two sessions racing a NEW collection: every record is readable by a cold session', async () => {
    const store = memoryStore()
    const boot = await open(store)
    await boot.openVault('v1')

    const A = await open(store), B = await open(store)
    const vA = await A.openVault('v1'), vB = await B.openVault('v1')
    await Promise.all([
      vA.collection<D>('fresh').put('a1', { id: 'a1', body: 'A' }),
      vB.collection<D>('fresh').put('b1', { id: 'b1', body: 'B' }),
    ])

    // both rows exist — the failure is never about the write landing
    expect((await store.list('v1', 'fresh')).sort()).toEqual(['a1', 'b1'])

    // ⭐ the property: a session that holds neither minted key reads both
    const cold = await open(store)
    const vC = await cold.openVault('v1')
    expect(await vC.collection<D>('fresh').get('a1')).toEqual({ id: 'a1', body: 'A' })
    expect(await vC.collection<D>('fresh').get('b1')).toEqual({ id: 'b1', body: 'B' })
  })

  it('three sessions, same collection — the winner is adopted by everyone', async () => {
    const store = memoryStore()
    const boot = await open(store); await boot.openVault('v1')
    const sessions = await Promise.all([open(store), open(store), open(store)])
    const vaults = await Promise.all(sessions.map(s => s.openVault('v1')))
    await Promise.all(vaults.map((v, i) => v.collection<D>('many').put(`r${i}`, { id: `r${i}`, body: `${i}` })))

    const cold = await open(store)
    const vC = await cold.openVault('v1')
    for (let i = 0; i < 3; i++) {
      expect(await vC.collection<D>('many').get(`r${i}`)).toEqual({ id: `r${i}`, body: `${i}` })
    }
  })

  it('the control — ONE session writing the same collection was never broken', async () => {
    // Passes on `main` as well. Without it, the rows above could be read as
    // "concurrency is broken" when the defect is specifically cross-session:
    // `inFlight` dedupes within a session and cannot see another.
    const store = memoryStore()
    const A = await open(store); const vA = await A.openVault('v1')
    await Promise.all([
      vA.collection<D>('solo').put('x1', { id: 'x1', body: 'X' }),
      vA.collection<D>('solo').put('x2', { id: 'x2', body: 'Y' }),
    ])
    const cold = await open(store); const vC = await cold.openVault('v1')
    expect(await vC.collection<D>('solo').get('x1')).toEqual({ id: 'x1', body: 'X' })
    expect(await vC.collection<D>('solo').get('x2')).toEqual({ id: 'x2', body: 'Y' })
  })
})
