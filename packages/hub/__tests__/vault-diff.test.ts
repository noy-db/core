import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError, createNoydb, diffVault } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; client: string; amount: number; status: string }

async function setup() {
  // historyStrategy enabled because the dump-JSON candidate test calls
  // vault.dump(); the architecture-invariants checker requires the
  // strategy when any dump()-using test lives in this file.
  const db = await createNoydb({
    store: toMemory(), user: 'alice', secret: 'pw-2026',
    historyStrategy: withHistory(),
  })
  const vault = await db.openVault('demo')
  const invoices = vault.collection<Invoice>('invoices')
  await invoices.put('a', { id: 'a', client: 'X', amount: 100, status: 'paid' })
  await invoices.put('b', { id: 'b', client: 'Y', amount: 200, status: 'draft' })
  await invoices.put('c', { id: 'c', client: 'Z', amount: 300, status: 'paid' })
  return { db, vault }
}

describe('diffVault — plain object candidate', () => {
  it('detects added / modified / deleted records relative to a plain map', async () => {
    const { db, vault } = await setup()

    const candidate: Record<string, Invoice[]> = {
      invoices: [
        // 'a' — unchanged
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        // 'b' — modified (status: 'draft' → 'paid')
        { id: 'b', client: 'Y', amount: 200, status: 'paid' },
        // 'c' — deleted (omitted from candidate)
        // 'd' — added
        { id: 'd', client: 'W', amount: 400, status: 'paid' },
      ],
    }

    const plan = await diffVault<Invoice>(vault, candidate)

    expect(plan.summary).toEqual({ add: 1, modify: 1, delete: 1, total: 3, skipped: 0 })
    expect(plan.added.map((e) => e.id)).toEqual(['d'])
    expect(plan.deleted.map((e) => e.id)).toEqual(['c'])
    expect(plan.modified).toHaveLength(1)
    expect(plan.modified[0]!.id).toBe('b')
    expect(plan.modified[0]!.fieldsChanged).toEqual(['status'])
    expect(plan.modified[0]!.fieldDiffs).toEqual([
      { path: 'status', type: 'changed', from: 'draft', to: 'paid' },
    ])

    db.close()
  })

  it('returns zero changes when candidate matches the live vault', async () => {
    const { db, vault } = await setup()
    const candidate: Record<string, Invoice[]> = {
      invoices: [
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        { id: 'b', client: 'Y', amount: 200, status: 'draft' },
        { id: 'c', client: 'Z', amount: 300, status: 'paid' },
      ],
    }
    const plan = await diffVault<Invoice>(vault, candidate)
    expect(plan.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0, skipped: 0 })
    db.close()
  })
})

describe('diffVault — Vault-vs-Vault candidate', () => {
  it('walks both vaults via exportStream and emits the same shape', async () => {
    const live = await setup()
    const cand = await setup()
    // Mutate the candidate so they diverge.
    const candVault = await cand.db.openVault('demo')
    await candVault.collection<Invoice>('invoices').put('e', {
      id: 'e', client: 'V', amount: 500, status: 'paid',
    })

    const plan = await diffVault<Invoice>(live.vault, candVault)
    expect(plan.summary.add).toBe(1)
    expect(plan.added[0]!.id).toBe('e')

    live.db.close()
    cand.db.close()
  })
})

describe('diffVault — collections filter', () => {
  it('restricts diff to the requested collections only', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'pw-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'X', amount: 100, status: 'paid' })
    await vault.collection<{ id: string; amt: number }>('payments').put('p', { id: 'p', amt: 100 })

    const candidate = {
      invoices: [{ id: 'a', client: 'X', amount: 100, status: 'paid' }],
      // payments missing — would normally show as a deleted record
    }

    const all = await diffVault(vault, candidate)
    expect(all.summary.delete).toBe(1)

    const scoped = await diffVault(vault, candidate, { collections: ['invoices'] })
    expect(scoped.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0, skipped: 0 })

    db.close()
  })
})

describe('diffVault — formatter', () => {
  it('emits a human-readable summary', async () => {
    const { db, vault } = await setup()
    const plan = await diffVault<Invoice>(vault, {
      invoices: [
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        { id: 'b', client: 'Y', amount: 250, status: 'draft' },
      ],
    })

    const count = plan.format({ detail: 'count' })
    expect(count).toMatch(/0 added.*1 modified.*1 deleted/)

    const full = plan.format({ detail: 'full' })
    expect(full).toContain('invoices/b')
    expect(full).toContain('modified')
    expect(full).toContain('amount: 200 → 250')
    expect(full).toContain('invoices/c')
    expect(full).toContain('deleted')
    db.close()
  })
})

describe('diffVault — vault.dump() JSON candidate', () => {
  it('parses a dump string and reduces it to the map shape', async () => {
    const { db: db1, vault: v1 } = await setup()
    const dump = await v1.dump()
    db1.close()

    // Live side has one extra record vs the dump.
    const { db: db2, vault: v2 } = await setup()
    await v2.collection<Invoice>('invoices').put('z', {
      id: 'z', client: 'fresh', amount: 99, status: 'paid',
    })

    const plan = await diffVault<Invoice>(v2, dump)
    // The dump is missing 'z' relative to v2, so 'z' is "deleted" from v2's perspective.
    expect(plan.deleted.map((e) => e.id)).toContain('z')
    db2.close()
  })
})

describe('diffVault — includeUnchanged', () => {
  it('returns unchanged buckets when explicitly requested', async () => {
    const { db, vault } = await setup()
    const candidate: Record<string, Invoice[]> = {
      invoices: [
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        { id: 'b', client: 'Y', amount: 200, status: 'draft' },
        { id: 'c', client: 'Z', amount: 300, status: 'paid' },
      ],
    }
    const off = await diffVault<Invoice>(vault, candidate)
    expect(off.unchanged).toBeUndefined()

    const on = await diffVault<Invoice>(vault, candidate, { includeUnchanged: true })
    expect(on.unchanged).toHaveLength(3)
    expect(on.unchanged!.map((e) => e.id).sort()).toEqual(['a', 'b', 'c'])
    db.close()
  })
})

/**
 * family#151 — an id-less record was silently invisible to the diff.
 *
 * ⛔ THE CONSEQUENCE WAS SILENT DATA LOSS ON IMPORT, not a cosmetic gap.
 * `diffVault` keyed BOTH sides on a record FIELD (`options.idKey`, default
 * `'id'`) and `continue`d on a record that had none — so such a record landed
 * in no bucket, and `@noy-db/hub/as`'s `plan().apply()` walks only
 * `added`/`modified`/`deleted`. The row was never written: no error, no count,
 * nothing. Hub's id is the STORE KEY, not a property of the plaintext, so a
 * record genuinely need not carry one.
 *
 * ⚠️ Two different fixes, because the two candidate kinds differ in what they
 * CAN be keyed by. A Vault candidate has hub ids on both sides, so both are
 * keyed by them and nothing is skippable. A plain object or a `dump()` string
 * carries no hub ids at all — keying the live side by hub id against a
 * field-keyed candidate would mismatch every record and report the whole vault
 * added-and-deleted — so that path still keys by field and REPORTS the skip
 * instead of hiding it.
 */
/** An EMPTY vault on its own store — the #151 cases seed their own rows. */
async function freshVault(name: string): Promise<{ db: Awaited<ReturnType<typeof createNoydb>>; vault: Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>> }> {
  const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'pw-2026' })
  return { db, vault: await db.openVault(name) }
}

describe('family#151 — records with no id field', () => {
  it('⭐ a vault-to-vault diff reports an id-less record as deleted', async () => {
    // The case the old keying could not see at all: present in the live vault,
    // absent from the candidate, no `id` field on either. Before this fix the
    // diff reported nothing.
    const a = await freshVault('v151a')
    const b = await freshVault('v151b')
    await a.vault.collection('rows').put('r1', { label: 'no id field here' } as never)

    const diff = await diffVault(a.vault, b.vault)
    expect(diff.summary.delete, 'an id-less record was invisible to the diff').toBe(1)
    expect(diff.deleted[0]?.id).toBe('r1') // the HUB id, not a field
    expect(diff.skipped).toEqual([])
    await a.db.close(); await b.db.close()
  })

  it('⭐ a vault-to-vault diff matches an id-less record present on both sides', async () => {
    // The control. Without it, a fix that reported EVERY record as deleted
    // would pass the case above.
    const a = await freshVault('v151c')
    const b = await freshVault('v151d')
    await a.vault.collection('rows').put('r1', { label: 'same' } as never)
    await b.vault.collection('rows').put('r1', { label: 'same' } as never)

    const diff = await diffVault(a.vault, b.vault)
    expect(diff.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0, skipped: 0 })
    await a.db.close(); await b.db.close()
  })

  it('⛔ an object candidate row with no id field is REPORTED, not dropped', async () => {
    const a = await freshVault('v151e')
    await a.vault.collection('rows').put('r1', { id: 'r1', n: 1 } as never)

    const diff = await diffVault(a.vault, { rows: [{ id: 'r1', n: 1 }, { n: 2 }] } as never)
    expect(diff.summary.skipped, 'the unkeyable row vanished from the diff').toBe(1)
    expect(diff.skipped[0]).toMatchObject({ collection: 'rows', side: 'candidate', index: 1 })
    await a.db.close()
  })

  it('a skip appears in format() at EVERY detail level, including count', async () => {
    // `format()` is what a human reads before approving an import. "0 added"
    // with rows quietly unimportable is the sentence this makes unprintable.
    const a = await freshVault('v151f')
    const diff = await diffVault(a.vault, { rows: [{ n: 1 }] } as never)
    for (const detail of ['count', 'one-line', 'full'] as const) {
      expect(diff.format({ detail }), `detail: ${detail}`).toMatch(/SKIPPED/)
    }
    await a.db.close()
  })
})
