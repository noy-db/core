/**
 * #11 — `writeQueue.pending` must cover the PRE-WRITE GATE phase.
 *
 * `writeQueue`'s documented use is a graceful-shutdown guard (its own JSDoc
 * example is a `beforeunload` handler). The schema fence does a fresh store
 * read on every put/delete, and that read used to happen OUTSIDE
 * `writeQueue.track()` — so `pending` read `false` during a real store
 * round-trip that is part of every write. A guard that is false inside the
 * window it exists to cover is worse than no guard: it reads as a promise
 * that was kept.
 *
 * ⚠️ THE SECOND TEST IS THE CONSTRAINT, NOT A BONUS. The gates were placed
 * outside `track()` deliberately — "so a rejected write never counts toward
 * writeQueue.depth". Entering the queue earlier must NOT record a refusal as a
 * queue failure, or a legitimate refusal would reject a concurrent `onFlush()`
 * drain. Widening the window and preserving that are one change, not two.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

interface Gate { block: Promise<void> | null; only: string | null; saw: string[] }

function blockingStore(gate: Gate): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' as const } },
    async get(v, c, i) {
      gate.saw.push(`${c}/${i}`)
      if (gate.block && gate.only === c) await gate.block
      return data.get(k(v, c, i)) ?? null
    },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const p = `${v}/${c}/`
      return [...data.keys()].filter(x => x.startsWith(p)).map(x => x.slice(p.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vn, cn, id] = key.split('/')
        if (vn === v) { out[cn!] = out[cn!] ?? {}; out[cn!]![id!] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

async function openDb(gate: Gate) {
  const db = await createNoydb({
    store: blockingStore(gate),
    user: 'alice',
    secret: 'issue-11-writequeue-gate-phase-secret',
  })
  const vault = await db.openVault('V')
  return { db, rows: vault.collection<{ id: string; tag: string }>('rows') }
}

describe('#11 — writeQueue covers the pre-write gate phase', () => {
  it('reports pending while a write is parked in the schema-fence read', async () => {
    const gate: Gate = { block: null, only: null, saw: [] }
    const { db, rows } = await openDb(gate)

    expect(db.writeQueue.pending).toBe(false)

    // Block the fence's per-write store read and start a put without awaiting.
    let release!: () => void
    gate.block = new Promise<void>((r) => { release = r })
    gate.only = '_meta'
    const inFlight = rows.put('r1', { id: 'r1', tag: 'a' })
    await new Promise((r) => setTimeout(r, 20))

    // The write IS in flight — a shutdown guard must see it.
    expect(gate.saw).toContain('_meta/schema-fence')
    expect(db.writeQueue.pending).toBe(true)
    expect(db.writeQueue.depth).toBe(1)

    release()
    gate.block = null
    gate.only = null
    await inFlight
    expect(db.writeQueue.depth).toBe(0)
  }, 30_000)

  it('does not record a REFUSED write as a queue failure', async () => {
    // The constraint the original placement protected: a refusal releases the
    // depth it took, and must not reject a drain that is already waiting.
    const gate: Gate = { block: null, only: null, saw: [] }
    const { db, rows } = await openDb(gate)

    db.onBeforeWrite(() => { throw new Error('refused by policy') })

    const drain = db.writeQueue.onFlush().then(() => 'resolved', (e: Error) => `REJECTED: ${e.message}`)
    await expect(rows.put('r2', { id: 'r2', tag: 'b' })).rejects.toThrow('refused by policy')

    expect(db.writeQueue.depth).toBe(0)
    expect(db.writeQueue.pending).toBe(false)
    expect(await drain).toBe('resolved')
  }, 30_000)
})
