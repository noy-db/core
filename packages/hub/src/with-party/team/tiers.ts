/**
 * Hierarchical access — tier-aware keyring helpers.
 *
 * The keyring's existing `deks: Map<string, CryptoKey>` is keyed by
 * collection name. extends the key space:
 *
 *   `'invoices'`      — tier-0 DEK (unchanged from v0.x)
 *   `'invoices#1'`    — tier-1 DEK
 *   `'invoices#2'`    — tier-2 DEK
 *
 * Tier 0 keeps the bare collection name so any keyring written
 * before tiers existed loads without migration. Tiers ≥ 1 use `#N`
 * suffixes that
 * would be invalid as user-supplied collection names (see
 * `ReservedCollectionNameError` — `#` is reserved).
 *
 * @module
 */

import type { UnlockedKeyring } from './keyring.js'
import { TierNotGrantedError } from '../../kernel/errors.js'

/** Canonical DEK key for a given collection + tier. Tier 0 → bare name. */
// Moved to `kernel/tier-visibility.ts` (#1042): the kernel needs it to resolve
// a pulled envelope's DEK, and `port-layering` forbids the spine importing a
// `with-*` service. Re-exported so every existing importer is unchanged.
import { dekKey } from '../../kernel/tier-visibility.js'
export { dekKey }

/**
 * Returns the user's effective clearance for a given collection: the
 * maximum tier for which their keyring holds a DEK. Falls back to 0
 * when the user has only the tier-0 DEK (or none — the getDEK caller
 * will raise separately).
 *
 * ## ⚠️ Called by nothing, and it is HALF of a pair (core#58)
 *
 * The other half is `KeyringFile.clearance` (`kernel/types.ts`), a persisted,
 * optional, explicitly advisory field whose own docstring describes this
 * computation — *"Owners and admins default to the highest tier they have DEKs
 * for at grant time"*. Measured: **nothing in the tree reads or writes it**,
 * and nothing calls this function. So the format poses a per-collection
 * clearance question that no code answers, on either side.
 *
 * ⛔ Do not delete this on a "no callers" signal alone. It is the only
 * implementation of what the persisted field means, and removing it leaves the
 * field with no definition at all. Do not delete the field either without
 * deciding what a keyring that already carries one should do.
 *
 * ⚠️ `kernel/vault.ts`'s `elevate()` scan is NOT this predicate and cannot be
 * replaced by a call to it: that asks whether ANY collection has a DEK at ONE
 * tier (`#N` suffix match); this asks the MAXIMUM tier for ONE collection
 * (`name#` prefix match). See core#58 for the table.
 */
export function effectiveClearance(keyring: UnlockedKeyring, collection: string): number {
  let max = 0
  const prefix = `${collection}#`
  for (const key of keyring.deks.keys()) {
    if (!key.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    const n = Number.parseInt(suffix, 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/**
 * Assert the caller is cleared for the requested tier. Owners and
 * admins always pass (they can mint any new tier DEK on demand);
 * other roles must already hold the tier DEK — via a prior grant or
 * an active delegation — otherwise this throws `TierNotGrantedError`.
 *
 * This gate runs BEFORE `getDEK()` on the mutation path so a
 * non-cleared operator never has the opportunity to silently
 * auto-create a tier DEK they shouldn't have.
 */
export function assertTierAccess(
  keyring: UnlockedKeyring,
  collection: string,
  tier: number,
): void {
  if (tier <= 0) return
  // FR-6: custodian operates every collection at every tier (admin-level
  // operational authority), so it may mint a tier DEK on demand like admin.
  if (keyring.role === 'owner' || keyring.role === 'admin' || keyring.role === 'custodian') return
  if (!keyring.deks.has(dekKey(collection, tier))) {
    throw new TierNotGrantedError(collection, tier)
  }
}
