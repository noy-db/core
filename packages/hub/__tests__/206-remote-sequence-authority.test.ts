/**
 * family#206 — sequence counters were per-DEVICE, so two devices issued the
 * SAME number. Measured before the fix: A `next()` → 1, A pushes, B pulls the
 * whole vault, B `next()` → 1. Two records numbered 1 after a COMPLETE sync
 * cycle, because `_sequences` is not replicated and `next()` CASes against the
 * LOCAL store — the pull cannot help when there is nothing to pull.
 *
 * ⭐ Fixed on the ISSUING side, not by replicating the counter.
 * `vault.sequence(name, { authority: 'remote' })` CASes against the attached
 * sync-peer's store, so there is exactly ONE counter and nothing to reconcile.
 * Why replication was rejected instead: `with-sync/reserved-mirror.ts` — the
 * mover is DEK-free by construction, so no rule there can compare two sealed
 * counter values, and the only available rule (`_v`) is wrong in both
 * directions for independently-incremented counters.
 *
 * ⚠️ Case 1 is the CONTROL THAT MATTERS MOST: `authority` absent must keep
 * today's behaviour exactly, duplicate numbers included. The option is
 * additive, and a fix that silently changed every existing local series would
 * be a different and much worse change.
 */
import { describe, it, expect } from 'vitest'
// ⚠️ The error comes from the ROOT BARREL, not from `/sequence`. That subpath
// publishes `SequenceNotEnabledError` alone (the opt-in gate's error), exactly
// as it did before family#206 — `SequenceOfflineError` and
// `SequenceContentionError` are root-barrel exports too, and this one joins
// them. Importing it from the subpath is what the first draft did, and
// `__tests__/surfaces/sequence.json` refused the widened surface.
import { createNoydb, ConflictError, SequenceAuthorityUnavailableError } from '../src/index.js'
import { withSequence } from '../src/with-commit/sequence/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

/** A CAS-honouring in-memory store. `casAtomic: false` makes it ineligible as an authority. */
function toMemory(casAtomic = true, name = 'memory'): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name,
    capabilities: { casAtomic, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined) {
        if (ev === 0 && ex) throw new ConflictError(ex._v)
        if (ev !== 0 && (!ex || ex._v !== ev)) throw new ConflictError(ex?._v ?? 0)
      }
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

/** One device: its own local store, optionally pointed at a shared remote. */
async function device(opts: { remote?: NoydbStore; role?: 'sync-peer' | 'backup'; encrypt?: boolean } = {}) {
  const db = await createNoydb({
    store: toMemory(true, 'local'),
    user: 'owner',
    encrypt: opts.encrypt ?? false,
    ...(opts.encrypt === true ? { secret: 'pw-for-the-tests-2026' } : {}),
    sequenceStrategy: withSequence(),
    // `attachSyncTarget` and a construction-time target both build a SyncEngine,
    // which is itself opt-in — without this the engine stub throws before any
    // of this feature is reached.
    syncStrategy: withSync(),
    ...(opts.remote ? { sync: { store: opts.remote, role: opts.role ?? 'sync-peer' } } : {}),
  })
  return { db, vault: await db.openVault('acme') }
}

describe('family#206 — a sequence can issue from one authority across devices', () => {
  it('0. PRECONDITION: the shared remote is CAS-capable, or nothing below means anything', async () => {
    // Every refusal case asserts an error. Without this, a harness whose remote
    // was silently non-CAS would make the SUCCESS cases fail and the refusal
    // cases pass — for the wrong reason.
    const remote = toMemory(true, 'remote')
    expect(remote.capabilities?.casAtomic, 'the harness cannot host an authority').toBe(true)
  })

  it('1. CONTROL: with no `authority`, two devices still issue the SAME number', async () => {
    // ⚠️ THE BUG, PRESERVED ON PURPOSE. This is the pre-fix behaviour and the
    // option is additive: a local series must keep issuing exactly as it did.
    // If this case ever goes green by returning 1 and 2, the change stopped
    // being additive and every existing caller's numbering moved.
    const remote = toMemory(true, 'remote')
    const a = await device({ remote })
    const b = await device({ remote })
    expect(await a.vault.sequence('invoice').next()).toBe(1)
    expect(await b.vault.sequence('invoice').next()).toBe(1)
    await a.db.close(); await b.db.close()
  })

  it('2. THE FIX: with `authority: remote`, two devices issue DISTINCT numbers', async () => {
    const remote = toMemory(true, 'remote')
    const a = await device({ remote })
    const b = await device({ remote })
    const first = await a.vault.sequence('invoice', { authority: 'remote' }).next()
    const second = await b.vault.sequence('invoice', { authority: 'remote' }).next()
    expect([first, second], 'two devices issued the same number from one authority').toEqual([1, 2])
    await a.db.close(); await b.db.close()
  })

  it('3. interleaved issuance across two devices yields no duplicates', async () => {
    // The CAS retry loop already serializes concurrent callers against ONE
    // store; this asserts that the store they now contend on is the SHARED one.
    const remote = toMemory(true, 'remote')
    const a = await device({ remote })
    const b = await device({ remote })
    const seqA = a.vault.sequence('invoice', { authority: 'remote' })
    const seqB = b.vault.sequence('invoice', { authority: 'remote' })
    const issued = await Promise.all([
      seqA.next(), seqB.next(), seqA.next(), seqB.next(), seqA.next(), seqB.next(),
    ])
    expect(new Set(issued).size, `duplicates issued: ${issued.join(',')}`).toBe(6)
    expect([...issued].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6])
    await a.db.close(); await b.db.close()
  })

  it('4. FAILS CLOSED with no sync target — and issues no local number instead', async () => {
    const { db, vault } = await device()
    const err = await vault.sequence('invoice', { authority: 'remote' }).next().then(
      () => null, (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SequenceAuthorityUnavailableError)
    expect((err as SequenceAuthorityUnavailableError).reason).toBe('no-target')
    // ⛔ THE SECOND HALF IS THE POINT. A refusal that quietly allocated a local
    // number would reproduce family#206 while reporting failure, and nothing in
    // the thrown error would say so.
    expect(await vault.sequence('invoice').peek(), 'a refused remote next() allocated a LOCAL number').toBe(0)
    await db.close()
  })

  it('5. FAILS CLOSED when the sync-peer is not CAS-capable', async () => {
    // Not theoretical: @noy-db/to-file is `casAtomic: false` by construction,
    // so a USB or shared-folder target can hold a vault and still not be able
    // to serialize issuance.
    const { db, vault } = await device({ remote: toMemory(false, 'not-cas-remote') })
    const err = await vault.sequence('invoice', { authority: 'remote' }).next().then(
      () => null, (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SequenceAuthorityUnavailableError)
    expect((err as SequenceAuthorityUnavailableError).reason).toBe('not-cas')
    expect(String(err), 'the message should name the store so the reader can act').toMatch(/casAtomic/)
    await db.close()
  })

  it('6. FAILS CLOSED when a BACKUP target is the only one attached', async () => {
    // A backup/archive target is push-only, so reading a counter back from it
    // was never part of its contract. `syncAdapter`'s selector would have
    // picked it (it falls back to the first target of any role) — this is the
    // case that proves the authority resolver does not.
    const { db, vault } = await device({ remote: toMemory(true, 'archive'), role: 'backup' })
    const err = await vault.sequence('invoice', { authority: 'remote' }).next().then(
      () => null, (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SequenceAuthorityUnavailableError)
    expect((err as SequenceAuthorityUnavailableError).reason).toBe('no-target')
    await db.close()
  })

  it('7. ENCRYPTED: refuses when this device has no `_sequences` key, and never mints one', async () => {
    // ⛔ THE RULED BEHAVIOUR (family#206). `getDEK` mints on first access, which
    // is right for a local counter and wrong here: minting would seal the
    // SHARED counter under a key the peer cannot unwrap, surfacing later as an
    // UNREADABLE counter rather than a wrong number. `_keyring` replicates, so
    // the remedy is a pull — and the error says so.
    const remote = toMemory(true, 'remote')
    const { db, vault } = await device({ remote, encrypt: true })
    const err = await vault.sequence('invoice', { authority: 'remote' }).next().then(
      () => null, (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SequenceAuthorityUnavailableError)
    expect((err as SequenceAuthorityUnavailableError).reason).toBe('no-key')
    expect(String(err)).toMatch(/Pull from the sync peer first/)
    // And it really did not mint: the remote holds no counter record.
    expect(await remote.list('acme', '_sequences'), 'a refused call wrote to the authority').toEqual([])

    // ⭐ `peek()` MUST REFUSE TOO, and this assertion is the one that earns the
    // EAGER key check its place. Added after mutation testing: deleting that
    // check reddened NOTHING, because `next()` still failed later on the
    // backstop inside `getDEK`. `peek()` is where the two differ — `read()`
    // returns early when the record is absent and never reaches a key
    // (`sequence/index.ts`'s `read`), so without the eager check `peek()`
    // quietly answers **0** for a counter this device cannot read. A caller
    // would conclude the series is unused when it may have issued thousands,
    // which is a worse failure than the error it replaced.
    const peekErr = await vault.sequence('invoice', { authority: 'remote' }).peek().then(
      () => null, (e: unknown) => e,
    )
    expect(peekErr, 'peek() reported a value for a counter it cannot read').toBeInstanceOf(
      SequenceAuthorityUnavailableError,
    )
    await db.close()
  })

  it('8. ENCRYPTED: once the `_sequences` key exists, remote authority works', async () => {
    // The positive half of case 7 — without it, case 7 would also pass if
    // remote authority were simply broken under encryption. Here a LOCAL series
    // mints the key (standing in for the pull that would deliver it in a real
    // fleet), after which the remote series issues normally.
    const remote = toMemory(true, 'remote')
    const { db, vault } = await device({ remote, encrypt: true })
    await vault.sequence('bootstrap').next() // mints the `_sequences` DEK locally
    expect(await vault.sequence('invoice', { authority: 'remote' }).next()).toBe(1)
    await db.close()
  })

  it('9. CONTROL: unencrypted vaults are not blocked by the key precondition', async () => {
    // An `encrypt: false` vault never calls `getDEK` at all and its keyring
    // carries no collection DEKs, so an ungated key check would refuse EVERY
    // remote series in unencrypted mode — for a key that is never used. Found
    // while writing these tests, before it shipped.
    const remote = toMemory(true, 'remote')
    const { db, vault } = await device({ remote, encrypt: false })
    expect(await vault.sequence('invoice', { authority: 'remote' }).next()).toBe(1)
    await db.close()
  })

  it('10. the two authorities are independent counters under one series name', async () => {
    // `resolveSequenceKey` derives the key from `partition` only, so the name
    // does not change — but the two authorities address DIFFERENT stores, so
    // the values are separate. Worth asserting because the alternative
    // (one memoized store serving both) would silently make them the same one.
    const remote = toMemory(true, 'remote')
    const { db, vault } = await device({ remote })
    expect(await vault.sequence('invoice').next()).toBe(1)
    expect(await vault.sequence('invoice').next()).toBe(2)
    expect(await vault.sequence('invoice', { authority: 'remote' }).next()).toBe(1)
    expect(await vault.sequence('invoice').peek(), 'the local counter moved with the remote one').toBe(2)
    await db.close()
  })

  it('11. peek() under remote authority reads the AUTHORITY, not the local store', async () => {
    const remote = toMemory(true, 'remote')
    const a = await device({ remote })
    const b = await device({ remote })
    await a.vault.sequence('invoice', { authority: 'remote' }).next()
    await a.vault.sequence('invoice', { authority: 'remote' }).next()
    expect(await b.vault.sequence('invoice', { authority: 'remote' }).peek()).toBe(2)
    expect(await b.vault.sequence('invoice').peek(), 'the local peek should still see nothing').toBe(0)
    await a.db.close(); await b.db.close()
  })

  it('12. a sync-peer attached AFTER open becomes the authority (core#90 shape)', async () => {
    const remote = toMemory(true, 'remote')
    const { db, vault } = await device() // opened with NO target
    await expect(vault.sequence('invoice', { authority: 'remote' }).next()).rejects.toThrow(
      SequenceAuthorityUnavailableError,
    )
    await db.attachSyncTarget('acme', { store: remote, role: 'sync-peer' })
    expect(await vault.sequence('invoice', { authority: 'remote' }).next()).toBe(1)
    await db.close()
  })
})
