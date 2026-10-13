/**
 * family#197 — the `_manifest/schema` write and its ledger append were not one
 * unit, so a concurrent sync could make the ledger describe an envelope that is
 * no longer the record's current one. `verifyBackupIntegrity` then reported
 * BACKUP_CORRUPTED on data nobody tampered with.
 *
 * ⛔ TWO HALVES, and only one of them is a race:
 *
 *  1. THE WRONG ENVELOPE. `auditManifestWrite` RE-READ the record
 *     (`store.get(...)`) and hashed whatever it found, then recorded that hash
 *     against OUR `expectedVersion + 1`. A sibling committing the next version
 *     in between meant the entry claimed our version with their hash. ⭐ Fixed
 *     by passing the envelope `writeSchemaManifest` just wrote — the window is
 *     REMOVED, not narrowed, and that holds across processes too.
 *  2. THE ORDERING. `verifyBackupIntegrity` recomputes the LATEST entry's hash
 *     against the CURRENT envelope, so two appends landing in the opposite
 *     order to their writes leave the latest entry carrying a stale hash. A
 *     per-(store, vault) critical section orders them WITHIN one process.
 *     ⚠️ Cross-process ordering is NOT closed and cannot be from inside one
 *     process — CAS orders the writes, not the appends. Reported, not papered
 *     over.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, memoryStore, writePod, readPod } from '../../src/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'

const SECRET = 'test-pw-12345678'
const VAULT = 'acme'
interface Invoice extends Record<string, unknown> { id: string; amount: number }

const Schema = z.object({ id: z.string(), amount: z.number() })

async function vaultWithManifest() {
  const store = memoryStore({ full: true })
  const db = await createNoydb({ store, user: 'alice', secret: SECRET, historyStrategy: withHistory() })
  const vault = await db.openVault(VAULT)
  vault.collection<Invoice>('invoices', { schema: Schema, persistJsonSchema: true })
  await vault._drainPendingSchemaWrites()
  await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
  return { db, vault, store }
}

describe('family#197 — the manifest write and its ledger append are one unit', () => {
  it('⭐ the ledger entry hashes the envelope that was WRITTEN', async () => {
    // The direct property: the latest `_manifest/schema` ledger entry's
    // payloadHash must match the record's current envelope. That is exactly
    // what verifyBackupIntegrity recomputes on restore.
    const { db, vault, store } = await vaultWithManifest()
    const { envelopePayloadHash } = await import('../../src/with-commit/history/ledger/index.js')

    const env = await store.get(VAULT, '_manifest', 'schema')
    expect(env, 'fixture: no manifest was written').not.toBeNull()

    const entries = await vault.ledger().loadAllEntries()
    const manifestEntries = entries.filter((e) => e.collection === '_manifest' && e.id === 'schema')
    expect(manifestEntries.length, 'fixture: no manifest ledger entry').toBeGreaterThan(0)

    const latest = manifestEntries[manifestEntries.length - 1]!
    expect(
      latest.payloadHash,
      'the ledger entry hashes an envelope other than the one stored',
    ).toBe(await envelopePayloadHash(env))
    await db.close()
  })

  it('⭐ the append does not depend on a RE-READ — proven with a lying store', async () => {
    // ⛔ WHY THIS CASE EXISTS. My first three tests all passed with the re-read
    // restored, because the per-vault lock stops any in-process sibling from
    // interleaving — so the re-read returned our own envelope and the two
    // implementations were indistinguishable. The half that matters
    // cross-process therefore had NO coverage, which is the exact "its green
    // did not cover the thing" shape this fix is about.
    //
    // A store whose `get` of `_manifest/schema` answers with a DIFFERENT
    // envelope than the one `put` separates them with no concurrency at all:
    // hashing the written envelope ignores the lie, hashing a re-read adopts it.
    const { envelopePayloadHash } = await import('../../src/with-commit/history/ledger/index.js')
    const inner = memoryStore({ full: true })
    let written: Awaited<ReturnType<typeof inner.get>> = null
    let lieOnNextGet = false
    const lying: typeof inner = {
      ...inner,
      put: async (v, c, i, env, ev) => {
        if (c === '_manifest' && i === 'schema') { written = env; lieOnNextGet = true }
        return inner.put(v, c, i, env, ev)
      },
      get: async (v, c, i) => {
        const real = await inner.get(v, c, i)
        // ⚠️ SURGICAL: lie only on the FIRST read AFTER a manifest put, which
        // is the audit's re-read. A blanket lie also corrupts the CAS read that
        // drives the sync loop, so `expectedVersion` goes wrong, every write
        // conflicts, and the test fails for a reason unrelated to the fix —
        // which is exactly what my first version of it did.
        if (c === '_manifest' && i === 'schema' && real !== null && lieOnNextGet) {
          lieOnNextGet = false
          return { ...real, _data: `${String(real._data)}-sibling` }
        }
        return real
      },
    }

    const db = await createNoydb({ store: lying, user: 'alice', secret: SECRET, historyStrategy: withHistory() })
    const vault = await db.openVault(VAULT)
    vault.collection<Invoice>('invoices', { schema: Schema, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    expect(written, 'fixture: no manifest envelope was written').not.toBeNull()
    const entries = (await vault.ledger().loadAllEntries())
      .filter((e) => e.collection === '_manifest' && e.id === 'schema')
    expect(entries.length, 'fixture: no manifest ledger entry').toBeGreaterThan(0)

    expect(
      entries[entries.length - 1]!.payloadHash,
      'the append hashed a RE-READ of the record, not the envelope it wrote',
    ).toBe(await envelopePayloadHash(written))
    await db.close()
  })

  it('⭐ concurrent manifest syncs leave a pod that reloads clean', async () => {
    // The reported symptom, end to end: drive several manifest syncs
    // concurrently over ONE store, then round-trip a pod. Before the fix the
    // post-load verifyBackupIntegrity reported corruption.
    const { db, vault } = await vaultWithManifest()

    vault.collection<Record<string, unknown>>('payments', {
      schema: z.object({ id: z.string() }), persistJsonSchema: true,
    } as never)
    vault.collection<Record<string, unknown>>('receipts', {
      schema: z.object({ id: z.string() }), persistJsonSchema: true,
    } as never)
    // Several drains in flight at once — the shape the critical section orders.
    await Promise.all([
      vault._drainPendingSchemaWrites(),
      vault._drainPendingSchemaWrites(),
      vault._drainPendingSchemaWrites(),
    ])

    const bytes = await writePod(vault, { compression: 'none' })
    const { dumpJson } = await readPod(bytes)
    expect(JSON.parse(dumpJson), 'the pod did not round-trip').toBeTruthy()
    await db.close()
  })

  it('CONTROL: a single sync still records exactly one manifest entry', async () => {
    // Serializing must not duplicate the append, and passing the envelope must
    // not skip it — both failure modes would pass the hash test above.
    const { db, vault } = await vaultWithManifest()
    const entries = (await vault.ledger().loadAllEntries())
      .filter((e) => e.collection === '_manifest' && e.id === 'schema')
    expect(entries.length, 'the manifest append was duplicated or dropped').toBe(1)
    await db.close()
  })
})
