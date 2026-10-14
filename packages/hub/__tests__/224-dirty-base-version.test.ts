/**
 * family#224 — a never-pushed record written N times was pushed with
 * `expectedVersion = localVersion - 1` and always conflicted once.
 *
 * `trackChange` deduplicates by (collection, id) and REPLACES the entry, so the
 * third local write of a never-pushed record carries `version: 3`, and push
 * derived its CAS as `version - 1` = 2 — while the remote held nothing. Every
 * such put was refused, the conflict path retried at `expectedVersion: 0`, and
 * the record cost two remote puts plus a conflict instead of one put.
 *
 * Measured on main: 3 records written 3 times each → **3 conflicts, 6 remote
 * puts**. Reported from DynamoDB as 107 `ConditionalCheckFailed` for 106
 * successful `PutItem` in one ten-minute window — a 400 in the console per
 * record.
 *
 * ⭐ The fix is to stop DERIVING the expectation. `DirtyEntry.base` is captured
 * when the record first becomes dirty and carried across later writes: the
 * remote has not advanced just because this device wrote again.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

/** An in-memory store that COUNTS puts and CAS refusals, which is the assertion. */
function counting() {
  const data = new Map<string, EncryptedEnvelope>()
  let conflicts = 0
  const puts: Record<string, number> = {}
  const k = (v: string, c: string, i: string) => `${v}|${c}|${i}`
  const store = {
    name: 'counting',
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v: string, c: string, i: string) { return data.get(k(v, c, i)) ?? null },
    async put(v: string, c: string, i: string, env: EncryptedEnvelope, ev?: number) {
      puts[c] = (puts[c] ?? 0) + 1
      const ex = data.get(k(v, c, i))
      if (ev !== undefined && (ex?._v ?? 0) !== ev) { conflicts++; throw new ConflictError(ex?._v ?? 0) }
      data.set(k(v, c, i), env)
    },
    async delete(v: string, c: string, i: string) { data.delete(k(v, c, i)) },
    async list(v: string, c: string) {
      const p = `${v}|${c}|`
      return [...data.keys()].filter((x) => x.startsWith(p)).map((x) => x.slice(p.length))
    },
    async loadAll(v: string) {
      const snap: VaultSnapshot = {}
      for (const [key, env] of data) {
        const [vn, cn, id] = key.split('|')
        if (vn === v && cn && id && !cn.startsWith('_')) { snap[cn] = snap[cn] ?? {}; snap[cn]![id] = env }
      }
      return snap
    },
    async saveAll() {},
  } as unknown as NoydbStore
  return { store, puts, conflicts: () => conflicts }
}

interface Row extends Record<string, unknown> { n: number }

async function pushAfterRepeatedWrites(writesPerRecord: number, records = 3) {
  const remote = counting()
  const db = await createNoydb({
    store: counting().store, sync: remote.store, user: 'owner', secret: 'pw-224-dirty-base-long',
    validateSecret: false, syncStrategy: withSync(),
  })
  const v = await db.openVault('acme')
  const c = v.collection<Row>('rows')
  for (let i = 0; i < records; i++) for (let w = 0; w < writesPerRecord; w++) await c.put(`r${i}`, { n: w })
  await db.push('acme')
  const result = { conflicts: remote.conflicts(), puts: remote.puts.rows ?? 0 }
  await db.close()
  return result
}

describe('family#224 — the dirty entry remembers the remote version', () => {
  it('1. THE BUG: a never-pushed record written 3 times pushes with NO conflict', async () => {
    const { conflicts, puts } = await pushAfterRepeatedWrites(3, 3)
    expect(conflicts, 'every record still conflicts once before the retry').toBe(0)
    expect(puts, 'each record should cost exactly ONE remote put').toBe(3)
  })

  it('2. a single write per record was never affected — the control', async () => {
    // Written once, `version` is 1 and `version - 1` is 0, so the old
    // derivation happened to be right. If this ever regresses, the fix broke
    // the case that always worked.
    const { conflicts, puts } = await pushAfterRepeatedWrites(1, 3)
    expect(conflicts).toBe(0)
    expect(puts).toBe(3)
  })

  it('3. it scales: 10 writes per record still costs one put each', async () => {
    const { conflicts, puts } = await pushAfterRepeatedWrites(10, 4)
    expect(conflicts).toBe(0)
    expect(puts).toBe(4)
  })

  it('4. CONTROL: a REAL conflict is still reported', async () => {
    // The fix must not become "never use a CAS". Two devices on one remote,
    // the second pushing a record the first already advanced, must still
    // conflict — otherwise case 1 would pass by disabling the mechanism.
    const remote = counting()
    const mk = async () => {
      const db = await createNoydb({
        store: counting().store, sync: remote.store, user: 'owner', secret: 'pw-224-dirty-base-long',
        validateSecret: false, syncStrategy: withSync(),
      })
      return { db, v: await db.openVault('acme') }
    }
    const a = await mk()
    await a.v.collection<Row>('rows').put('shared', { n: 1 })
    await a.db.push('acme')          // remote now at _v 1

    const b = await mk()
    await b.v.collection<Row>('rows').put('shared', { n: 2 }) // b never pulled; its base is 0
    const before = remote.conflicts()
    await b.db.push('acme')
    expect(remote.conflicts(), 'a genuine divergence no longer conflicts').toBeGreaterThan(before)
    await a.db.close(); await b.db.close()
  })

  it('5. CONTROL: an entry with no `base` still pushes — the older-build fallback', async () => {
    // The dirty list is PERSISTED, so an upgrade can find entries written
    // without `base`. Push must fall back to the old derivation rather than
    // treating `undefined` as 0 and clobbering.
    const remote = counting()
    const local = counting()
    const db = await createNoydb({
      store: local.store, sync: remote.store, user: 'owner', secret: 'pw-224-dirty-base-long',
      validateSecret: false, syncStrategy: withSync(),
    })
    const v = await db.openVault('acme')
    await v.collection<Row>('rows').put('r0', { n: 1 })
    await db.push('acme')                                   // remote at _v 1
    await v.collection<Row>('rows').put('r0', { n: 2 })     // local _v 2, base 1

    // Strip `base` from the persisted dirty list, as an older build would have left it.
    const meta = await local.store.get('acme', '_sync', 'meta')
    const doc = JSON.parse(meta!._data!) as { dirty: Array<Record<string, unknown>> }
    for (const e of doc.dirty) delete e.base
    await local.store.put('acme', '_sync', 'meta', { ...meta!, _data: JSON.stringify(doc) })

    const db2 = await createNoydb({
      store: local.store, sync: remote.store, user: 'owner', secret: 'pw-224-dirty-base-long',
      validateSecret: false, syncStrategy: withSync(),
    })
    await db2.openVault('acme')
    const before = remote.conflicts()
    await db2.push('acme')
    expect(remote.conflicts(), 'the fallback derivation did not apply').toBe(before)
    await db.close(); await db2.close()
  })
})
