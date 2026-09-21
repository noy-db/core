/**
 * Secret-bearing reserved collections — the `_`-prefixed reserved collections
 * whose record CONTENTS are directly-usable secrets (transport OAuth tokens,
 * connection strings, API keys), as opposed to the *operational* reserved
 * collections (`_ledger`, `_history`, `_sync`, …) whose contents are metadata
 * (collection names, record ids, ciphertext hashes).
 *
 * This distinction matters at two trust-boundary seams:
 *
 *  1. `vault.collection()` — a secret-bearing reserved name must never be
 *     reachable through the generic public collection handle. It is served
 *     ONLY by its dedicated, role-gated API (e.g. `_sync_credentials` →
 *     `getCredential`/`putCredential`, which enforce owner/admin access).
 *
 *  2. `grant()` DEK propagation — a sub-admin grantee (operator, viewer,
 *     client, custodian) must NOT receive a secret-bearing collection's DEK.
 *     Operational reserved DEKs still propagate to every role (grantees must
 *     write ledger/history entries on every mutation), but handing a
 *     sub-admin the `_sync_credentials` DEK would let them decrypt the firm's
 *     transport secrets — a plaintext leak, not a metadata leak.
 *
 * Kept dependency-free so both the kernel (`vault.ts`) and the team layer
 * (`keyring.ts`) can import it without an import cycle.
 */

/** Reserved collection holding per-adapter sync transport secrets. */
export const SYNC_CREDENTIALS_COLLECTION = '_sync_credentials'

/**
 * Reserved collection holding the credential broker's SHARED seed (#479):
 * one record per `brokerId`, owner/admin only.
 */
export const BROKER_COLLECTION = '_broker'

/**
 * Reserved collection holding each MEMBER's own broker seed (core#73): one
 * record per `userId`, each encrypted under a DEK minted for that grantee
 * alone at `grant()` time. Secret-bearing like `_broker`, with one twist the
 * propagation loops must honour: the grantor never HOLDS this DEK (it is
 * per-grantee, minted and wrapped in one step), so there is nothing to
 * withhold — the guard exists so the name can never be served by
 * `vault.collection()`.
 */
export const BROKER_MEMBER_COLLECTION = '_broker_member'

/**
 * The set of reserved collection names whose record contents are
 * directly-usable secrets. Membership here means: never served via
 * `vault.collection()`, never propagated to sub-admin grantees.
 */
const SECRET_BEARING_RESERVED_COLLECTIONS: ReadonlySet<string> = new Set([
  SYNC_CREDENTIALS_COLLECTION,
  BROKER_COLLECTION,
  BROKER_MEMBER_COLLECTION,
])

/** True when `name` is a secret-bearing reserved collection. */
export function isSecretBearingReservedCollection(name: string): boolean {
  return SECRET_BEARING_RESERVED_COLLECTIONS.has(name)
}
