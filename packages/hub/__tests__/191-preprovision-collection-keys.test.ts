/**
 * family#191 — two DEVICES that each write the first record of an empty
 * collection mint two DEKs for it, and each side's records become unreadable
 * to the other.
 *
 * ## The mechanism
 *
 * DEKs are minted on a collection's FIRST WRITE (`ensureCollectionDEK`).
 * core#132 closed the same race for two SESSIONS over one store with a CAS on
 * `persistKeyring` — mint, persist, adopt the winner on conflict. Two devices
 * have separate local stores, so neither sees the other's CAS and each
 * encrypts under its own key.
 *
 * ⚠️ THE SYMPTOM IS WORSE THAN THE REPORT SAID, which quoted core#132's note
 * about `TamperedError`. Measured here: A's record reaches the remote, B's
 * pull does NOT store it, and B logs NO rejection. The record is dropped with
 * no trace at all — nothing throws, nothing is recorded, and `get` answers
 * `null` as though it had never been written.
 *
 * ## Why pre-provisioning is enough, with no new replication
 *
 * `_keyring` is already `RESERVED_REPLICATION[0]`, so a DEK that exists BEFORE
 * any write travels on its own. The whole defect is timing. Case 2 below is
 * the one that proves it, by running the identical scenario twice and changing
 * only whether the collection was declared.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, ValidationError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple river stone'
type Row = { n: number }

function open(store: NoydbStore, remote: NoydbStore) {
  return createNoydb({ store, sync: remote, user: 'owner', secret: S, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam() })
}

/**
 * A declares `invoices` (or not) and writes NOTHING, then pushes its keyring.
 * B joins, writes the FIRST record, pushes. A writes too and pulls.
 *
 * ⭐ A writes nothing before pushing ON PURPOSE. If it wrote, the DEK would be
 * minted by the write and the arms would not differ — which is exactly the
 * mistake the first version of this probe made.
 */
async function raceWithDeclaration(declared: readonly string[] | undefined) {
  const remote = memoryStore({ full: true })
  const dbA = await open(memoryStore({ full: true }), remote)
  const vA = await dbA.openVault('acme', declared ? { collections: declared } : undefined)
  await dbA.push('acme')

  const dbB = await open(memoryStore({ full: true }), remote)
  const vB = await dbB.openVault('acme')
  await dbB.pull('acme')
  await vB.collection<Row>('invoices').put('b1', { n: 2 })
  await dbB.push('acme')

  await vA.collection<Row>('invoices').put('a1', { n: 1 })
  await dbA.pull('acme')
  const aReadsB = await vA.collection<Row>('invoices').get('b1').then((r) => r, () => null)
  await dbA.close(); await dbB.close()
  return aReadsB
}

describe('family#191 — pre-provisioned collection keys', () => {
  it('1. THE BUG: with no declaration, the two devices diverge and a record vanishes', async () => {
    // ⚠️ Asserts the CURRENT behaviour of the undeclared path, which is
    // residual 1 and is NOT fixed by this change. Kept so the residual is
    // documented by something that runs, not by a sentence.
    expect(await raceWithDeclaration(undefined), 'the undeclared race now converges — update this case').toBeNull()
  })

  it('2. THE FIX: declaring the collection makes the identical scenario converge', async () => {
    // Same scenario, same ordering, one difference: `collections: ['invoices']`
    // at open. A still writes nothing before pushing, so the ONLY reason the
    // DEK is in its keyring is the provisioning.
    expect(await raceWithDeclaration(['invoices']), "A still cannot read B's record").toEqual({ n: 2 })
  })

  it('3. provisionCollectionKeys reports what it minted, and is idempotent', async () => {
    const remote = memoryStore({ full: true })
    const db = await open(memoryStore({ full: true }), remote)
    const v = await db.openVault('acme')
    const first = await v.provisionCollectionKeys(['invoices', 'clients'])
    expect([...first.minted].sort()).toEqual(['clients', 'invoices'])
    expect(first.existing).toEqual([])

    // CONTROL: re-running must mint NOTHING. A consumer calling this on every
    // boot depends on it, and a second mint would be the very divergence the
    // API exists to prevent.
    const second = await v.provisionCollectionKeys(['invoices', 'clients'])
    expect(second.minted, 'a repeat provisioning minted a second key').toEqual([])
    expect([...second.existing].sort()).toEqual(['clients', 'invoices'])
    await db.close()
  })

  it('4. a reserved collection is refused rather than quietly accepted', async () => {
    // Residual 3: reserved DEKs are minted by the subsystem that owns them on
    // first use, so naming one here could not change when it appears.
    // Accepting the name would imply a guarantee this cannot give.
    const remote = memoryStore({ full: true })
    const db = await open(memoryStore({ full: true }), remote)
    const v = await db.openVault('acme')
    await expect(v.provisionCollectionKeys(['_sync_credentials'])).rejects.toThrow(ValidationError)
    await db.close()
  })

  it('5. CONTROL: a declared collection still behaves normally for a single device', async () => {
    // Provisioning must not change ordinary reads and writes — without this,
    // case 2 would also pass if declaring a collection broke it in some way
    // that happened to make both sides agree.
    const remote = memoryStore({ full: true })
    const db = await open(memoryStore({ full: true }), remote)
    const v = await db.openVault('acme', { collections: ['invoices'] })
    await v.collection<Row>('invoices').put('x', { n: 7 })
    expect(await v.collection<Row>('invoices').get('x')).toEqual({ n: 7 })
    await db.close()
  })

  it('6. CONTROL: declaring on a SECOND open of a cached vault also provisions', async () => {
    // `openVault`'s cached branch returns early, so the two returns had to go
    // through one helper. Without this, a caller declaring on a later open
    // would silently get nothing.
    const remote = memoryStore({ full: true })
    const db = await open(memoryStore({ full: true }), remote)
    await db.openVault('acme')                                    // cached after this
    const v = await db.openVault('acme', { collections: ['late'] })
    expect([...(await db.team.getKeyring('acme')).deks.keys()]).toContain('late')
    expect(await v.provisionCollectionKeys(['late'])).toEqual({ minted: [], existing: ['late'] })
    await db.close()
  })
})
