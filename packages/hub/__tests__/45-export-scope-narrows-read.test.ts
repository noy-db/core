/**
 * core#45(b) — `collections` narrows the READ, not only the output.
 *
 * Half (a) documented the old behaviour honestly: the option filtered chunks
 * after `exportStream` had already decrypted the whole vault. This is the half
 * that makes the documented caveat FALSE rather than merely known.
 *
 * ⚠️ Why the assertions are about the STORE and not about the returned chunks.
 * Chunk-level assertions cannot tell the two implementations apart — post-read
 * filtering and a narrowed read produce identical output, which is exactly why
 * core#43's conformance assertion was impossible at this layer. The difference
 * is only visible in what was fetched and decrypted.
 *
 * ⛔ SEED IN THE FIRST INSTANCE, MEASURE ON A REOPENED ONE. Hub serves reads
 * from its decrypted cache after hydration, so an export run against the vault
 * that just wrote the records touches the store zero times and every counter
 * here reads 0 — a green test measuring nothing. Same trap the as-* conformance
 * fixture records.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { Noydb, NoydbStore, ExportChunk } from '../src/index.js'
import { withFormats } from '../src/port/as/active.js'
import { withTeam } from '../src/with-party/team/index.js'

interface Invoice { id: string; total: number }

/** A store that records which collections were fetched, and how. */
function countingStore(): { store: NoydbStore; gets: string[]; lists: string[]; loadAlls: number } {
  const inner = memoryStore()
  const gets: string[] = []
  const lists: string[] = []
  const counters = { loadAlls: 0 }
  const store = {
    ...inner,
    get: (v: string, c: string, id: string) => {
      gets.push(c)
      return inner.get(v, c, id)
    },
    list: (v: string, c: string) => {
      lists.push(c)
      return inner.list(v, c)
    },
    loadAll: (v: string) => {
      counters.loadAlls += 1
      return inner.loadAll(v)
    },
  } as NoydbStore
  return {
    store,
    gets,
    lists,
    get loadAlls() {
      return counters.loadAlls
    },
  }
}

async function seeded(store: NoydbStore): Promise<Noydb> {
  const open = async (): Promise<Noydb> =>
    await createNoydb({
      store,
      user: 'owner-45',
      secret: 'pw-export-scope-45',
      formatsStrategy: withFormats(),
      teamStrategy: withTeam(),
    })
  const first = await open()
  const vault = await first.openVault('acme')
  await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', total: 10 })
  await vault.collection<Invoice>('payments').put('p1', { id: 'p1', total: 7 })
  await vault.collection<Invoice>('clients').put('c1', { id: 'c1', total: 3 })
  await first.grant('acme', {
    userId: 'owner-45', displayName: 'Owner', role: 'owner', secret: 'pw-export-scope-45',
    exportCapability: { plaintext: ['probe'] },
  })
  await first.close()
  return await open()
}

describe('core#45(b): exportStream({ collections }) narrows the read', () => {
  it('DECRYPTS only the requested collections', async () => {
    const counting = countingStore()
    const db = await seeded(counting.store)
    const vault = await db.openVault('acme')

    counting.gets.length = 0
    const chunks: ExportChunk[] = []
    for await (const chunk of vault.exportStream({ collections: ['invoices'] })) chunks.push(chunk)

    expect(chunks.map((c) => c.collection)).toEqual(['invoices'])
    // The property. A record `get()` is the decrypt path, so a fetch of an
    // excluded collection IS the excluded collection being decrypted.
    expect(
      [...new Set(counting.gets)],
      'an excluded collection was still decrypted — the option filtered output only',
    ).toEqual(['invoices'])
    await db.close()
  })

  it('does not bulk-read the whole vault when a scope is given', async () => {
    // The cost half. `loadAll` pulls every collection's envelopes out of the
    // store; a scoped export has no reason to.
    const counting = countingStore()
    const db = await seeded(counting.store)
    const vault = await db.openVault('acme')

    // ⚠️ The window opens HERE. `openVault` lists and loads on the way in, so
    // a lifetime-wide assertion would be measuring hydration, not the export —
    // and would fail on reads the export never made.
    const before = counting.loadAlls
    counting.lists.length = 0
    for await (const _ of vault.exportStream({ collections: ['invoices'] })) { /* drain */ }

    expect(
      counting.loadAlls - before,
      'a scoped export still bulk-read the entire vault',
    ).toBe(0)
    expect(counting.lists).toContain('invoices')
    expect(counting.lists).not.toContain('payments')
    await db.close()
  })

  it('UNSCOPED still exports everything — the control', async () => {
    // Without this, both cases above are satisfied by an export that reads
    // nothing at all, and the narrowing would be indistinguishable from a
    // broken export.
    const counting = countingStore()
    const db = await seeded(counting.store)
    const vault = await db.openVault('acme')

    counting.gets.length = 0
    const seen: string[] = []
    for await (const chunk of vault.exportStream()) seen.push(chunk.collection)

    expect(seen.sort()).toEqual(['clients', 'invoices', 'payments'])
    expect([...new Set(counting.gets)].sort()).toEqual(['clients', 'invoices', 'payments'])
    await db.close()
  })

  it('an unknown collection name yields nothing rather than throwing', async () => {
    // A vault legitimately may not hold every name a caller asks for — a
    // format exporting "these three if present" is a normal call, and
    // throwing would make the caller pre-check what the export already knows.
    const counting = countingStore()
    const db = await seeded(counting.store)
    const vault = await db.openVault('acme')

    const seen: string[] = []
    for await (const chunk of vault.exportStream({ collections: ['nope'] })) seen.push(chunk.collection)

    expect(seen).toEqual([])
    await db.close()
  })

  it('an INTERNAL collection cannot be exported by naming it', async () => {
    // `loadAll` filters underscore-prefixed internals, and the unscoped path
    // relies on that. A scoped path that skips loadAll must apply the same
    // rule itself, or naming `_keyring` would export the keyring — a filter
    // silently lost by taking a different route to the same data.
    const counting = countingStore()
    const db = await seeded(counting.store)
    const vault = await db.openVault('acme')

    const seen: string[] = []
    for await (const chunk of vault.exportStream({ collections: ['_keyring'] })) seen.push(chunk.collection)

    expect(seen, 'an internal collection was exported by naming it explicitly').toEqual([])
    await db.close()
  })

  it('vault.export(fmt, { collections }) inherits the narrowing', async () => {
    // The port passed `collections` to its own post-read filter because
    // ExportStreamOptions had no field for it (core#45). It threads it now, so
    // the caller-facing method is what actually changed.
    const counting = countingStore()
    const db = await seeded(counting.store)
    const vault = await db.openVault('acme')

    counting.gets.length = 0
    const out = await vault.export(
      {
        id: 'probe',
        extension: 'txt',
        mimeType: 'text/plain',
        tier: 'plaintext' as const,
        encode: (chunks) => chunks.map((c) => c.collection).join(','),
      },
      { collections: ['invoices'] },
    )

    expect(out).toBe('invoices')
    expect(
      [...new Set(counting.gets)],
      'vault.export still decrypted every collection — the port filters post-read',
    ).toEqual(['invoices'])
    await db.close()
  })
})
