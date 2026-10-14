/**
 * family#225 — two hub instances on ONE local store (two browser tabs of one
 * origin) each drove push and pull off the dirty snapshot they loaded at open.
 *
 * ## Measured
 *
 * | probe | before family#223 | after family#223 | after this change |
 * |---|---|---|---|
 * | tab2 writes, tab1 pushes | `[r1]`, queue wiped | `[r1]`, row kept | `[r1, r2]` |
 * | tab2 writes, closes unpushed, reopen pushes | `[r1]` — **lost** | `[r1, r2]` | `[r1, r2]` |
 * | tab1 pushes all session, tab2 never does | never arrives | never arrives | arrives |
 *
 * ⛔ AND THE ONE THE ROW DID NOT NAME. `pull()` consults `this.dirty` to find a
 * collision. Blind to the other tab's row it called a dirty record clean,
 * applied the remote copy over it, consulted no resolver and emitted no
 * conflict. With `conflict: 'local-wins'`, an identical sequence run on ONE
 * instance reported the conflict and kept the edit; run across two it reported
 * nothing and the edit was gone. That control is case 2.
 *
 * The fix is not a new API: family#223 already made the durable queue
 * per-entry and shared, so the rows ARE the queue and `this.dirty` is a cache
 * of them. Every read of it AS THE QUEUE reconciles first — push, filtered
 * push, pull — and never the write path, which is the O(N) shape family#223
 * removed (case 5).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ConflictStrategy } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

function counting() {
  const data = new Map<string, EncryptedEnvelope>()
  const puts: Record<string, number> = {}
  /** Every put ATTEMPT, counted before the CAS — a refused one never reaches `puts`. */
  const attempts: Record<string, number> = {}
  const lists: Record<string, number> = {}
  const k = (v: string, c: string, i: string) => `${v}|${c}|${i}`
  const store = {
    name: 'counting',
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v: string, c: string, i: string) { return data.get(k(v, c, i)) ?? null },
    // ⚠️ The CAS is implemented, not stubbed: cases 3 and 4 turn on a refused
    // expectedVersion, and a fake that ignored it would pass them vacuously.
    // Semantics copied from `memoryStore` — an absent id is version 0
    // (family#147), so `expectedVersion: 0` still creates.
    async put(v: string, c: string, i: string, e: EncryptedEnvelope, expectedVersion?: number) {
      attempts[c] = (attempts[c] ?? 0) + 1
      const current = data.get(k(v, c, i))?._v ?? 0
      if (expectedVersion !== undefined && current !== expectedVersion) {
        throw new ConflictError(current, `Version conflict: expected ${expectedVersion}, found ${current}`)
      }
      puts[c] = (puts[c] ?? 0) + 1
      data.set(k(v, c, i), e)
    },
    async delete(v: string, c: string, i: string) { data.delete(k(v, c, i)) },
    async list(v: string, c: string) {
      lists[c] = (lists[c] ?? 0) + 1
      const p = `${v}|${c}|`
      return [...data.keys()].filter((x) => x.startsWith(p)).map((x) => x.slice(p.length))
    },
    async loadAll(v: string) {
      const s: VaultSnapshot = {}
      for (const [key, e] of data) {
        const [vn, cn, id] = key.split('|')
        if (vn === v && cn && id && !cn.startsWith('_')) { s[cn] = s[cn] ?? {}; s[cn]![id] = e }
      }
      return s
    },
    async saveAll() {},
  } as unknown as NoydbStore
  return { store, puts, attempts, lists, data }
}

interface Row extends Record<string, unknown> { n: number }
const SECRET = 'pw-225-shared-queue-long'
const V = 'acme'

const open = (local: NoydbStore, remote: NoydbStore, conflict?: ConflictStrategy) => createNoydb({
  store: local, sync: remote, user: 'owner', secret: SECRET,
  validateSecret: false, syncStrategy: withSync(), ...(conflict ? { conflict } : {}),
})
const rows = (db: Awaited<ReturnType<typeof open>>) => db.openVault(V).then(v => v.collection<Row>('rows'))

describe('family#225 — the rows are the queue, not one instance snapshot', () => {
  it('1. THE BUG: a push delivers a write tracked by the OTHER instance', async () => {
    const local = counting(); const remote = counting()
    const tab1 = await open(local.store, remote.store)
    await (await rows(tab1)).put('r1', { n: 1 })
    const tab2 = await open(local.store, remote.store)
    await (await rows(tab2)).put('r2', { n: 2 })

    // tab1 is the only instance that ever pushes — the shape pilot-2 reported,
    // and the one a primary/secondary app produces by itself.
    const res = await tab1.push(V)
    expect(await remote.store.list(V, 'rows'), "tab2's write was left behind").toEqual(['r1', 'r2'])
    expect(res.pushed).toBe(2)
    expect(await local.store.list(V, '_sync_dirty'), 'the queue was not drained').toEqual([])
    tab1.close(); tab2.close()
  })

  it('2. THE WORSE ONE: a pull honours the other instance’s mark — with a one-instance control', async () => {
    // `local-wins` is the discriminating policy: under the default `version`
    // the blind path reaches the same outcome by luck, so a test on `version`
    // alone would have passed before this change.
    async function run(twoInstances: boolean) {
      const local = counting(); const remote = counting()
      const tab1 = await open(local.store, remote.store, 'local-wins')
      const c1 = await rows(tab1)
      await c1.put('r1', { n: 1 })
      await tab1.push(V)

      // another device advances r1 remotely to _v 4
      const away = await open(counting().store, remote.store, 'local-wins')
      await away.openVault(V); await away.pull(V)
      const cAway = await rows(away)
      await cAway.put('r1', { n: 70 }); await cAway.put('r1', { n: 71 })
      await away.push(V)

      // the edit `local-wins` must keep, made in the second instance or in tab1
      const tab2 = twoInstances ? await open(local.store, remote.store, 'local-wins') : null
      const editor = tab2 ? await rows(tab2) : c1
      await editor.put('r1', { n: 2 })

      const pulled = await tab1.pull(V)
      await (tab2 ?? tab1).push(V)
      const witness = await open(counting().store, remote.store, 'local-wins')
      await witness.openVault(V); await witness.pull(V)
      const onRemote = await (await rows(witness)).get('r1')

      tab1.close(); away.close(); witness.close(); tab2?.close()
      return { conflicts: pulled.conflicts?.length ?? 0, onRemote }
    }

    const control = await run(false)
    expect(control, 'the single-instance control changed meaning').toMatchObject({ conflicts: 1 })
    expect(control.onRemote, 'control: local-wins did not keep the local edit').toMatchObject({ n: 2 })

    const two = await run(true)
    expect(two.conflicts, 'the collision with the other instance’s mark went unreported').toBe(1)
    expect(two.onRemote, 'the other instance’s edit was discarded and the policy ignored').toMatchObject({ n: 2 })
  })

  it('3. both instances pushing the same entry is a no-op, not a conflict', async () => {
    const local = counting(); const remote = counting()
    const tab1 = await open(local.store, remote.store)
    const tab2 = await open(local.store, remote.store)
    // ⚠️ tab2 pushes FIRST, on an empty queue, so its `ensureLoaded` is done
    // and only the reconcile can hand it the row below. Without this an
    // `ensureLoaded` on a fresh instance supplies the row by itself and the
    // case passes with the reconcile removed — a guard that tests #223.
    await tab2.openVault(V)
    await tab2.push(V)
    await (await rows(tab1)).put('r1', { n: 1 })

    // Both now see the same row. The loser's CAS fails, re-reads, and finds the
    // remote holding its own envelope byte-for-byte (one shared local store).
    const [a, b] = await Promise.all([tab1.push(V), tab2.push(V)])
    // Load-bearing: two attempts is what makes this a double push at all.
    expect(remote.attempts.rows, 'only one instance attempted the entry — this is not a double push').toBe(2)
    expect([...a.conflicts, ...b.conflicts], 'a replay was reported as a conflict').toEqual([])
    expect([...a.errors, ...b.errors]).toEqual([])
    expect(a.pushed + b.pushed, 'the record was sent twice as a success').toBe(1)
    expect(await remote.store.list(V, 'rows')).toEqual(['r1'])
    expect(await local.store.list(V, '_sync_dirty'), 'the row outlived both pushes').toEqual([])
    tab1.close(); tab2.close()
  })

  it('4. the base a row already carries survives a second instance’s edit', async () => {
    const local = counting(); const remote = counting()
    const tab1 = await open(local.store, remote.store)
    const c1 = await rows(tab1)
    await c1.put('r1', { n: 1 })          // remote gets _v 1
    await tab1.push(V)

    // ⚠️ tab2 must have LOADED before tab1 writes, or its own `ensureLoaded`
    // supplies tab1's row and nothing is being tested — the first version of
    // this case made that mistake and passed with the carry removed.
    const tab2 = await open(local.store, remote.store)
    await tab2.openVault(V)
    await tab2.push(V)                    // drains nothing; ends `ensureLoaded`

    await c1.put('r1', { n: 2 })          // local _v 2, tab1's row carries base 1
    await (await rows(tab2)).put('r1', { n: 3 }) // local _v 3 — the base must stay 1

    const res = await tab2.push(V)
    // Without the carried base tab2 would expect the remote at _v 2, the CAS
    // would refuse, and this would be a reported conflict instead of a push.
    expect(res.conflicts, 'the base drifted upward and the CAS refused').toEqual([])
    expect(res.pushed).toBe(1)
    expect((await remote.store.get(V, 'rows', 'r1'))?._v).toBe(3)
    tab1.close(); tab2.close()
  })

  it('5. the reconcile is NOT on the write path', async () => {
    const local = counting(); const remote = counting()
    const db = await open(local.store, remote.store)
    const c = await rows(db)
    for (let i = 0; i < 40; i++) await c.put(`r${i}`, { n: i })
    // The one enumeration is `ensureLoaded`'s, at open. The property is that it
    // does not GROW with N — a per-write `list()` is the O(N) shape family#223
    // removed — so the same count is asserted again at 5× the writes below,
    // rather than an absolute budget, which would rot.
    expect(local.lists._sync_dirty ?? 0, 'the write path enumerates the queue').toBe(1)
    expect(local.puts._sync_dirty, 'one row per write').toBe(40)
    const before = local.lists._sync_dirty ?? 0
    await db.push(V)
    expect((local.lists._sync_dirty ?? 0) - before, 'a push reconciles once, not per entry').toBe(1)
    db.close()

    const wide = counting()
    const db2 = await open(wide.store, counting().store)
    const c2 = await rows(db2)
    for (let i = 0; i < 200; i++) await c2.put(`r${i}`, { n: i })
    expect(wide.lists._sync_dirty ?? 0, '5x the writes enumerated the queue more often').toBe(1)
    db2.close()
  })

  it('6. a queue left by a closed instance still pushes (family#223 control)', async () => {
    const local = counting(); const remote = counting()
    const tab1 = await open(local.store, remote.store)
    await (await rows(tab1)).put('r1', { n: 1 })
    const tab2 = await open(local.store, remote.store)
    await (await rows(tab2)).put('r2', { n: 2 })
    tab2.close()                     // the secondary closes, never pushing
    await tab1.push(V)
    expect(await remote.store.list(V, 'rows')).toEqual(['r1', 'r2'])
    tab1.close()
  })
})
