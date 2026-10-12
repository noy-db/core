/**
 * How `Vault.exportStream()` decides WHAT to read (core#45b).
 *
 * Extracted from `vault.ts` rather than inlined there: the kernel-surface
 * ratchet had that file at its exact ceiling, and this is the kind of thing
 * the ceiling exists to push out — a self-contained decision with its own
 * reasoning, reachable from one call site.
 *
 * ## The property this file owns
 *
 * A scoped export must not FETCH or DECRYPT the collections it excludes.
 * Until 0.8 the scope was a filter applied to chunks after `exportStream` had
 * already decrypted the whole vault, so a caller narrowing an export to limit
 * what a compromised process could observe got no such limit. Choosing the
 * enumeration strategy — bulk snapshot vs per-collection `list` — is what
 * makes the difference real, and it is invisible to every chunk-level
 * assertion (`__tests__/45-export-scope-narrows-read.test.ts` observes the
 * store instead, which is the only layer that can tell them apart).
 *
 * @module
 */
import type { NoydbStore, ExportStreamOptions, VaultSnapshot, EncryptedEnvelope } from './types.js'

/** Where an export's collection names and record ids come from. */
export interface ExportSource {
  /** Collection names to export, sorted. */
  readonly collections: readonly string[]
  /** True when the caller supplied a scope. */
  readonly scoped: boolean
  /** Record ids in one collection. */
  ids(collection: string): Promise<readonly string[]>
  /**
   * The raw envelope for one record, for `withEnvelopeMeta` (family#166).
   *
   * ⚠️ THE TWO SOURCES ANSWER THIS AT DIFFERENT PRICES, and the caller must
   * only ask when the option was set. The bulk source already holds the whole
   * snapshot, so this is a map lookup; the scoped source enumerated with `list`
   * and has no envelopes, so this is a store `get` per record. Making it part
   * of the source interface rather than reaching for `adapter` at the call site
   * is what keeps that difference in ONE place — the same reason core#45b put
   * the enumeration strategy here.
   */
  envelope(collection: string, id: string): Promise<EncryptedEnvelope | null>
}

/**
 * Resolve the read strategy for one export.
 *
 * ⛔ THE UNDERSCORE FILTER IS APPLIED ON BOTH PATHS. `loadAll` drops
 * underscore-prefixed internal collections for free; `list` does not, so a
 * caller naming `_keyring` would export the keyring. A rule that holds only on
 * the route that happens to be taken is a rule waiting to be lost.
 */
export async function resolveExportSource(
  adapter: NoydbStore,
  vault: string,
  opts: ExportStreamOptions,
): Promise<ExportSource> {
  const scope = opts.collections
    ? [...new Set(opts.collections)].filter((n) => !n.startsWith('_')).sort()
    : null

  if (scope) {
    return {
      collections: scope,
      scoped: true,
      // One `list` per requested collection. Calling `loadAll` here would pull
      // every collection's envelopes out of the store before declining to
      // decrypt most of them — the fetch would already have happened, which is
      // precisely the half that makes "scoping" a word rather than a property.
      ids: async (collection) => await adapter.list(vault, collection),
      // One `get` per record, and only when `withEnvelopeMeta` is set — a
      // scoped export that does not ask still reads exactly what core#45b
      // narrowed it to.
      envelope: async (collection, id) => await adapter.get(vault, collection, id),
    }
  }

  // One bulk read to enumerate everything. The ids are already in hand, so
  // asking the store again per collection would re-read what we hold.
  const snapshot: VaultSnapshot = await adapter.loadAll(vault)
  return {
    collections: Object.keys(snapshot).sort(),
    scoped: false,
    ids: async (collection) => Object.keys(snapshot[collection] ?? {}),
    // Free: the envelope is already in the snapshot this source was built from.
    envelope: async (collection, id) => snapshot[collection]?.[id] ?? null,
  }
}

/**
 * `_v`/`_ts` for one exported record (family#166).
 *
 * ⚠️ A NULL ENVELOPE YIELDS VERSION 0, not a gap. The record was readable a
 * moment ago (the caller only asks after a non-null `get`), so null here means
 * it was deleted mid-export — and family#147 ruled that absence IS version 0
 * at the store contract, so reporting 0 is the same answer the CAS gives rather
 * than a new sentinel. Returning `undefined` instead would break the
 * positional alignment that `ExportChunk.envelopeMeta` is built on, which is
 * the one property a consumer cannot recover.
 */
export async function readEnvelopeMeta(
  source: ExportSource,
  collection: string,
  id: string,
): Promise<{ version: number; ts: string }> {
  const envelope = await source.envelope(collection, id)
  return { version: envelope?._v ?? 0, ts: envelope?._ts ?? '' }
}
