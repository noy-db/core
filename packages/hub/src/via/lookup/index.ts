/**
 * `via/lookup/` barrel — the dict/enum-tier lookup engine (#650
 * Task 1 — via-lookup extraction, phase D of the Via port).
 *
 * Not a dedicated public package subpath (no `@noy-db/hub/lookup` entry) —
 * its declaration surface (`lookup`/`enumOf`/`enum`/`dict` + the public
 * types) is re-exported from the root `@noy-db/hub` barrel (`src/index.ts`)
 * instead. This module itself is reached from the kernel spine only through
 * `port/with/lookup-strategy.ts`, and, for the existing `vault.dictionary()`
 * surface, through `via/i18n/active.ts`.
 */

/**
 * The engine's own surface, presented at its barrel. Consumers inside hub import these from `port/with/lookup-strategy.ts` (the kernel spine may not reach into `via/lookup/*` at all — Check 14), so the barrel has no importer for them by design.
 *
 * @seam
 */
export { LookupHandle, DictionaryHandle, DICT_COLLECTION_PREFIX, dictCollectionName, type DictEntry, type DictionaryOptions } from './handle.js'
/**
 * Registry surface at the barrel — reached through the port, same reason as above.
 *
 * @seam
 */
export { enforceStaticDictOnPut, resolveDictSource, updateReferencingRecords, type DictReferencingCollection } from './registry.js'
/**
 * The strategy factory. Deliberately NOT on the root barrel or any subpath — check-architecture.mjs:693-707 records the measurement and the reason (one way to configure lookup in front of consumers).
 *
 * @seam
 */
export { withLookup } from './active.js'
// #650 Task 2 — the 'lookup' via binding + its three descriptor tiers.
export { lookup, enumOf, enumOf as enum, dict, type LookupDescriptor, type Vocabulary, type LookupBacking, type OnDelete } from './descriptor.js'
/**
 * Binding surface at the barrel — `lookupVia` is taken from here; its siblings are reached through the port.
 *
 * @seam
 */
export { lookupVia, linkLookupVia, type LookupViaConfig } from './binding.js'
// #650 Task 7 — the describeFragment payload shape (first-ever consumer: with-shape/introspection/describe.ts).
/**
 * The describeFragment payload shape (#650 Task 7) — its consumer imports it from `binding.js` directly.
 *
 * @seam
 */
export type { LookupDescribeFragment, LookupDescribeFragmentEntry } from './binding.js'
