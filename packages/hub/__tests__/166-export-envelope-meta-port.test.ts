/**
 * family#166, the FORMAT-PORT half — `vault.export` can now ask for
 * `envelopeMeta`.
 *
 * `exportStream({ withEnvelopeMeta: true })` shipped earlier and gave every
 * exported record its store-level `_v` and `_ts`. The format port had no way
 * to request it: `vault.export` never passed the flag, so a format ready to
 * emit write metadata — `as-sql`'s `metadataColumns` is the reason this
 * exists — always received chunks without it and wrote NULLs.
 *
 * ⚠️ `FormatExportOptions.withEnvelopeMeta` is forwarded to `exportStream`,
 * not applied afterwards: the meta is read from the STORE beside each record,
 * so it has to be requested AT the read. A post-hoc pass could only recover it
 * by re-reading, which is the cost the flag exists to keep opt-in.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { NoydbFormat } from '../src/port/as/index.js'
import { withFormats } from '../src/port/as/active.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { ExportChunk } from '../src/kernel/types.js'

const SECRET = 'pw-export-envelope-meta-166'
type Row = { id: string; n: number }

/** Captures the chunks the port hands `encode`, which is what is under test. */
function capturing(): { format: NoydbFormat<string>; seen: ExportChunk[] } {
  const seen: ExportChunk[] = []
  return {
    seen,
    format: {
      id: 'metaprobe', extension: 'txt', mimeType: 'text/plain', tier: 'plaintext',
      encode: (chunks) => { seen.push(...chunks); return String(chunks.length) },
    },
  }
}

async function vaultWithExportGrant() {
  const store = memoryStore()
  const open = () => createNoydb({
    store, user: 'alice', secret: SECRET,
    formatsStrategy: withFormats(), teamStrategy: withTeam(),
  })
  // ⚠️ The grant is required, not boilerplate — a plaintext export is a
  // granted capability per format id, and the granting session holds the
  // pre-grant keyring, so it has to be reopened afterwards.
  const first = await open()
  const seeding = await first.openVault('acme')
  await seeding.collection<Row>('invoices').put('i1', { id: 'i1', n: 1 })
  await seeding.collection<Row>('invoices').put('i2', { id: 'i2', n: 2 })
  await seeding.collection<Row>('invoices').put('i2', { id: 'i2', n: 22 }) // _v becomes 2
  await first.grant('acme', {
    userId: 'alice', displayName: 'Alice', role: 'owner', secret: SECRET,
    exportCapability: { plaintext: ['metaprobe'] },
  })
  await first.close()
  const db = await open()
  return { db, vault: await db.openVault('acme') }
}

describe('family#166 — withEnvelopeMeta through the format port', () => {
  it('1. CONTROL: absent by default, so every case below means something', async () => {
    const { db, vault } = await vaultWithExportGrant()
    const { format, seen } = capturing()
    await vault.export(format)
    expect(seen.length).toBeGreaterThan(0)
    for (const c of seen) expect(c.envelopeMeta, 'meta arrived unasked — it costs a read per record').toBeUndefined()
    await db.close()
  })

  it('2. THE FIX: vault.export({ withEnvelopeMeta: true }) carries it', async () => {
    const { db, vault } = await vaultWithExportGrant()
    const { format, seen } = capturing()
    await vault.export(format, { withEnvelopeMeta: true })
    const invoices = seen.find((c) => c.collection === 'invoices')
    expect(invoices, 'the invoices chunk never reached the format').toBeDefined()
    expect(invoices!.envelopeMeta, 'the port did not forward the flag to exportStream').toBeDefined()
    expect(invoices!.envelopeMeta!.length, 'meta is not aligned with records').toBe(invoices!.records.length)
    await db.close()
  })

  it('3. it is real STORE metadata — the re-put record reports _v 2', async () => {
    // Without this the case above would pass on a correctly-sized array of
    // anything. `i2` was written twice, so its store version is 2 and `i1`'s
    // is 1 — a business field could not produce that.
    const { db, vault } = await vaultWithExportGrant()
    const { format, seen } = capturing()
    await vault.export(format, { withEnvelopeMeta: true })
    const c = seen.find((x) => x.collection === 'invoices')!
    const byId = new Map(c.records.map((r, i) => [(r as Row).id, c.envelopeMeta![i]!]))
    expect(byId.get('i1')!.version).toBe(1)
    expect(byId.get('i2')!.version, 'the twice-written record should be at version 2').toBe(2)
    expect(byId.get('i1')!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await db.close()
  })

  it('4. ⛔ the alignment SURVIVES redaction', async () => {
    // `redactChunk` maps records 1:1 and spreads the rest of the chunk, so
    // `envelopeMeta` rides along and stays aligned. That is an invariant, not
    // a coincidence: a redaction that ever FILTERED records would shift every
    // later record's version and timestamp onto its neighbour, and nothing
    // downstream could detect the skew. This is the case that fails if anyone
    // turns that `map` into a `filter`.
    const { db, vault } = await vaultWithExportGrant()
    const { format, seen } = capturing()
    await vault.export(format, { withEnvelopeMeta: true, redact: true })
    const c = seen.find((x) => x.collection === 'invoices')!
    expect(c.envelopeMeta, 'redaction dropped the meta entirely').toBeDefined()
    expect(c.envelopeMeta!.length, 'redaction broke the positional alignment').toBe(c.records.length)
    await db.close()
  })
})
