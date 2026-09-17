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
import type { NoydbStore, ExportStreamOptions, VaultSnapshot } from './types.js'

/** Where an export's collection names and record ids come from. */
export interface ExportSource {
  /** Collection names to export, sorted. */
  readonly collections: readonly string[]
  /** True when the caller supplied a scope. */
  readonly scoped: boolean
  /** Record ids in one collection. */
  ids(collection: string): Promise<readonly string[]>
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
    }
  }

  // One bulk read to enumerate everything. The ids are already in hand, so
  // asking the store again per collection would re-read what we hold.
  const snapshot: VaultSnapshot = await adapter.loadAll(vault)
  return {
    collections: Object.keys(snapshot).sort(),
    scoped: false,
    ids: async (collection) => Object.keys(snapshot[collection] ?? {}),
  }
}
