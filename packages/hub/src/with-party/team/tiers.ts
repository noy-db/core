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
 * The user's effective clearance for ONE collection: the maximum tier for which
 * their keyring holds a DEK. `0` when only the tier-0 DEK is held (or none —
 * the `getDEK` caller raises separately).
 *
 * Takes DEK SLOT NAMES rather than an `UnlockedKeyring` (core#58), because the
 * callers that need this are the ones BUILDING a `KeyringFile`, where the slot
 * names exist and an unlocked keyring may not. Not published from any entry, so
 * the signature is free to say what it means.
 *
 * ⚠️ `kernel/vault.ts`'s `elevate()` scan is NOT this predicate: that asks
 * whether ANY collection has a DEK at ONE tier (`#N` suffix match); this asks
 * the MAXIMUM tier for ONE collection (`name#` prefix match).
 */
export function effectiveClearance(dekSlots: Iterable<string>, collection: string): number {
  let max = 0
  const prefix = `${collection}#`
  for (const key of dekSlots) {
    if (!key.startsWith(prefix)) continue
    const n = Number.parseInt(key.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/**
 * The whole keyring's clearance: the highest tier held for ANY collection.
 *
 * ## What this is, and the one thing it must never become (core#58)
 *
 * This is the value persisted as `KeyringFile.clearance`. It is **derived**,
 * not independent — a pure function of the DEK slot names written into the same
 * file — and that is deliberate on two counts:
 *
 *  1. `dek_slots` is already bound into the roster tag (#1115), so a clearance
 *     computed from it carries no authority the tag does not already cover. A
 *     store that forges one contradicts data it cannot forge.
 *  2. Being derived at every write is what stops it drifting. A value computed
 *     once at grant time and carried forward goes stale the moment a tier DEK
 *     is added or revoked.
 *
 * ⛔ **It is ADVISORY and must stay advisory.** The real check is whether the
 * DEK map carries a `collection#tier` entry — `assertTierAccess` is the gate,
 * and access in this system IS the key. Never branch a privilege decision on
 * this number: it would be a second, weaker representation of access sitting
 * beside the authoritative one, which is how the two come to disagree.
 */
export function keyringClearance(dekSlots: Iterable<string>): number {
  const slots = [...dekSlots]
  let max = 0
  for (const collection of new Set(slots.map((s) => s.split('#')[0] as string))) {
    const c = effectiveClearance(slots, collection)
    if (c > max) max = c
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
