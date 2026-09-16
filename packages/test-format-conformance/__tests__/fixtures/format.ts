/**
 * A synthetic `as-*` format, and the fixture a format package would hand the
 * kit. Shared by the suites in this directory.
 *
 * ⚠️ NOT a `.test.ts`: these files are run by a CHILD vitest from
 * `scope-assertion.test.ts`, which asserts the kit's own pass/fail. If the main
 * run collected them, `wrong-option.suite.ts` — which is supposed to FAIL —
 * would fail the suite that reads it as evidence.
 *
 * ⭐ The shape is `as-csv`'s, deliberately: the entry point passes `collections`
 * THROUGH to `vault.export`, where hub owns the read (`chunks(collections)`),
 * and omits the key when it is absent. That pass-through is why an unrecognised
 * option name degrades to "export everything" instead of erroring, which is the
 * whole of core#43. A format that scoped by filtering chunks AFTER an unscoped
 * read would not show the defect at the store at all — worth knowing before
 * reading the scope case as universal.
 */
import { createNoydb, memoryStore, type Noydb, type Vault, type ExportChunk } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'
import { withFormats, type NoydbFormat } from '@noy-db/hub/as'
import { observeStore, type ObservedStore, type FormatFixture } from '../../src/index.js'

interface Invoice { id: string; total: number }

/** A minimal plaintext format. The encoding is irrelevant; the SCOPE is the subject. */
export const syntheticCsv: NoydbFormat<string> = {
  id: 'csv',
  extension: 'csv',
  mimeType: 'text/csv;charset=utf-8',
  tier: 'plaintext',
  encode: (chunks: readonly ExportChunk[]) =>
    chunks.map((c) => `${c.collection},${(c.records ?? []).length}`).join('\n'),
}

/** Options as a format package takes them. `collections` is the CURRENT name. */
export interface ExportOptions {
  readonly collections?: readonly string[]
}

/**
 * The entry point, written the way `as-csv`'s is — the scope is threaded only
 * when present, so an option name the package no longer recognises silently
 * becomes "everything".
 */
export async function exportText(vault: Vault, options: ExportOptions = {}): Promise<string> {
  return await vault.export(syntheticCsv, {
    ...(options.collections ? { collections: options.collections } : {}),
  })
}

async function build(): Promise<{ db: Noydb; vault: Vault; store: ObservedStore }> {
  // ⛔ `observeStore` wraps where the store is CREATED. A wrapper applied after
  // the vault exists intercepts nothing — the vault captured its store at
  // construction. The kit's own docs say so; this obeys it.
  const store = observeStore(memoryStore())
  const open = async (): Promise<Noydb> =>
    await createNoydb({
      store, user: 'owner-01', secret: 'pw-conformance-01',
      teamStrategy: withTeam(), formatsStrategy: withFormats(),
    })

  // ⛔ SEED IN THE FIRST INSTANCE, RETURN THE REOPENED VAULT UNTOUCHED. Writing
  // records after the reopen populates hub's decrypted cache, and the export is
  // then served from it — ZERO store reads, so the kit's store observation sees
  // nothing and its own control case ("the ungated call DOES read the store")
  // fails. Cost me an hour: hub's reads are cache-served after hydration
  // (the same property core#38 records for queries), so WHEN a fixture seeds
  // decides whether the store is observable at all.
  const first = await open()
  const seeded = await first.openVault('acme')
  await seeded.collection<Invoice>('invoices').put('i1', { id: 'i1', total: 10 })
  await seeded.collection<Invoice>('payments').put('p1', { id: 'p1', total: 7 })
  await first.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'pw-conformance-01',
    exportCapability: { plaintext: ['csv'] },
  })
  await first.close()

  const db = await open()
  return { db, vault: await db.openVault('acme'), store }
}

/** @param scoped - the arguments the entry point is called with. */
export function fixtureFor(scoped: ExportOptions): FormatFixture {
  const entry = { name: 'exportText', run: (v: Vault) => exportText(v, scoped) }
  return {
    tier: 'plaintext',
    format: 'csv',
    vault: async () => (await build()).vault,
    observableVault: async () => {
      const { vault, store } = await build()
      return { vault, store }
    },
    exports: [entry],
  }
}
