/**
 * family#219 (c) — a recovery proof cannot restore DEKs minted after the
 * credential was enrolled. This makes that LOUD; it does not close it.
 *
 * ## The gap, measured
 *
 * A recovery entry wraps a SNAPSHOT of the DEK set taken at enrolment
 * (`WrappedDeksBlob` = AES-GCM over `{ deks: { coll: rawDek } }`), and
 * `recoverViaPaperCode` rebuilds the keyring's `deks` from that snapshot
 * ALONE. So: write `a`, enrol, write `b`, recover — and `b`'s DEK is gone.
 *
 * ⛔ IT CANNOT BE REPAIRED ON THIS PATH, which is why (c) reports instead of
 * fixing. `b`'s DEK exists only wrapped under the OLD KEK, derived from the
 * secret the user has just told us they lost. Covering future DEKs has to
 * happen at MINT time, and every way of doing that touches a stored format —
 * a user ruling, since the free-format-break window is closed.
 *
 * ## What (c) changes
 *
 * `recoverSecret` returns `uncoveredCollections`, and the `NoAccessError` a
 * reader meets afterwards names the recovery cause and stops telling a sole
 * OWNER to "re-grant the user" — advice that is impossible for the grantor and
 * points away from the real cause. That wording is how this was reported: an
 * inexplicable NoAccessError on the reporter's own collection.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, mintPaperRecoveryEntry, type PaperRecoveryEntry } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'mem',
    async get(c: string, col: string, id: string) { return gc(c, col).get(id) },
    async put(c: string, col: string, id: string, env: EncryptedEnvelope) { gc(c, col).set(id, env) },
    async delete(c: string, col: string, id: string) { gc(c, col).delete(id) },
    async list(c: string, col: string) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const OLD = 'correct horse battery staple printer toaster'
const NEW = 'glasses cabinet bicycle umbrella thunder velvet'
type Row = { n: number }

/** Write `a`, enrol one paper code, then optionally write `b` AFTER enrolment. */
async function enrolThenMaybeWrite(opts: { writeAfter: boolean }) {
  const store = memory()
  const db = await createNoydb({ store, user: 'alice', secret: OLD })
  const v = await db.openVault('acme')
  await v.collection<Row>('a').put('a1', { n: 1 })

  const keyring = await db.team.getKeyring('acme')
  const code = 'CODEAAA001'
  const entries: PaperRecoveryEntry[] = [await mintPaperRecoveryEntry(keyring.deks, code, 'c0')]
  await db.team.enrollRecovery('acme', { profile: 'paper', entries })

  if (opts.writeAfter) await v.collection<Row>('b').put('b1', { n: 2 })

  const result = await db.team.recoverSecret('acme', {
    newSecret: NEW, recoveryProof: { profile: 'paper', payload: { code } },
  })
  await db.close()
  return { store, result }
}

describe('family#219 (c) — the uncovered-DEK gap is reported, not silent', () => {
  it('1. recoverSecret NAMES the collection it could not restore', async () => {
    const { result } = await enrolThenMaybeWrite({ writeAfter: true })
    expect(result.uncoveredCollections, 'the lost DEK was not reported').toEqual(['b'])
  })

  it('2. CONTROL: complete coverage reports nothing', async () => {
    // Without this, case 1 would also pass if the field simply always listed
    // something. Nothing is created after enrolment here, so the entry covers
    // the whole set.
    const { result } = await enrolThenMaybeWrite({ writeAfter: false })
    expect(result.uncoveredCollections).toEqual([])
  })

  it('3. CONTROL: recovery still works for everything it DID cover', async () => {
    // The gap must not read as "recovery is broken". `a` was in the snapshot
    // and must round-trip under the new secret.
    const { store } = await enrolThenMaybeWrite({ writeAfter: true })
    const db2 = await createNoydb({ store, user: 'alice', secret: NEW })
    const v2 = await db2.openVault('acme')
    expect(await v2.collection<Row>('a').get('a1')).toEqual({ n: 1 })
    await db2.close()
  })

  it('4. the NoAccessError names the RECOVERY cause and does not tell an owner to re-grant themselves', async () => {
    const { store } = await enrolThenMaybeWrite({ writeAfter: true })
    const db2 = await createNoydb({ store, user: 'alice', secret: NEW })
    const v2 = await db2.openVault('acme')
    const err = await v2.collection<Row>('b').get('b1').then(() => null, (e: unknown) => e as Error)

    expect(err, 'reading an uncovered collection should still fail').toBeInstanceOf(Error)
    const msg = String(err?.message)
    expect(msg, 'the recovery cause is not named').toMatch(/recovery/i)
    expect(msg, 'family#219 is not citable from the error').toMatch(/family#219/)
    expect(msg, 'the caller is not pointed at the new field').toMatch(/uncoveredCollections/)
    // ⛔ The original text's only remedy. alice is the OWNER, so there is
    // nobody to re-grant her: the advice was impossible AND pointed away from
    // the real cause.
    expect(msg, 'an owner was told to re-grant themselves').not.toMatch(/re-grant the user to give them the key/)
    await db2.close()
  })

  it('5. THE RESIDUAL, asserted so a future fix has something to flip', async () => {
    // ⚠️ This asserts the CURRENT behaviour, which is a known data-loss gap and
    // NOT desirable: an uncovered collection is unreachable after recovery.
    // (c) is deliberately report-only — closing it is family#219 (a)/(b), both
    // of which touch a stored format and need a user ruling. When one lands,
    // THIS case is the one that must change, and its failure is the signal that
    // the gap actually closed rather than moved.
    const { store } = await enrolThenMaybeWrite({ writeAfter: true })
    const db2 = await createNoydb({ store, user: 'alice', secret: NEW })
    const v2 = await db2.openVault('acme')
    await expect(
      v2.collection<Row>('b').get('b1'),
      'if this now RESOLVES, the gap is closed — update this case rather than deleting it',
    ).rejects.toThrow(/holds no key/)
    expect([...(await db2.team.getKeyring('acme')).deks.keys()]).not.toContain('b')
    await db2.close()
  })
})
