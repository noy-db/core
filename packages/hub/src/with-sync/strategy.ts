/**
 * Strategy seam for the optional sync engine + presence service.
 * Core imports `SyncStrategy` type-only + `NO_SYNC` stub; the real
 * `SyncEngine`, `SyncTransaction`, and `PresenceHandle` constructors
 * are only reachable via `withSync()` in `./sync-active.ts`.
 *
 * Solo apps that never configure `sync` and never call
 * `collection.presence()` ship none of the ~856 LOC behind this seam
 * (`sync.ts` + `sync-transaction.ts` + `presence.ts`).
 *
 * Note: `keyring.ts` (~746 LOC) stays in core because it's required
 * for any multi-user vault — even single-owner vaults use a keyring
 * to wrap the DEK. The team package's grant/revoke/magic-link/
 * delegation modules tree-shake naturally via direct named imports.
 *
 * Behavior under NO_SYNC:
 *
 * - **buildSyncEngine** — throws. Only fires when `createNoydb({ sync })`
 *   passes a remote target.
 * - **buildSyncTransaction** — throws. Only fires when `db.transaction(vault)`
 *   is called on a vault with sync configured.
 * - **buildPresence** — throws. Only fires when user code calls
 *   `collection.presence()`.
 *
 * @internal
 */

import type {
  NoydbStore,
  ConflictStrategy,
  SyncTargetRole,
} from '../kernel/types.js'
import type { MergeAuthority } from '../port/with/merge-authority.js'
import type { NoydbEventEmitter } from '../kernel/events.js'
import type { SyncPolicy } from '../kernel/sync-policy.js'
import type { SyncEngine } from './engine.js'
import type { SyncTransaction } from './transaction.js'
import type { PresenceHandle, PresenceHandleOpts } from './presence.js'
import type { Vault } from '../kernel/vault.js'

/**
 * Options accepted by `SyncStrategy.buildSyncEngine`. Mirrors the
 * `SyncEngine` constructor verbatim — kept here so core code never
 * imports the sync module at runtime.
 *
 * @internal
 */
export interface BuildSyncEngineOptions {
  local: NoydbStore
  remote: NoydbStore
  vault: string
  strategy: ConflictStrategy
  emitter: NoydbEventEmitter
  syncPolicy?: SyncPolicy
  role?: SyncTargetRole
  label?: string
  /** #1042 — the merge's verify/re-stamp capability, bound to the keys by the caller. */
  mergeAuthority?: MergeAuthority
  /** core#107 — this device is the vault's arbiter: its admission refusals replicate. */
  arbiter?: boolean
}

/**
 * @internal
 */
export interface SyncStrategy {
  buildSyncEngine(opts: BuildSyncEngineOptions): SyncEngine
  /**
   * core#75 — open-path roster bootstrap: an EMPTY local store is not a new
   * vault when a `sync-peer` already carries the roster. Runs inside keyring
   * resolution, BEFORE any engine exists; the un-opted-in stub is a no-op
   * (no sync ⇒ no target to bootstrap from).
   */
  bootstrapKeyrings(local: NoydbStore, peer: NoydbStore | undefined, vault: string): Promise<void>
  buildSyncTransaction(vault: Vault, engine: SyncEngine): SyncTransaction
  buildPresence<P>(opts: PresenceHandleOpts): PresenceHandle<P>
}

function notEnabled(op: string): Error {
  return new Error(
    `${op} requires the sync strategy. Import ` +
    '`{ withSync }` from "@noy-db/hub/sync" and pass it to ' +
    '`createNoydb({ syncStrategy: withSync() })`.',
  )
}

/**
 * No-sync stub. Every constructor throws with an actionable pointer
 * — there is no useful "off" mode for sync engine / presence /
 * sync-transaction; if the consumer reached one of these surfaces,
 * they intended to use it.
 *
 * @internal
 */
export const NO_SYNC: SyncStrategy = {
  buildSyncEngine() { throw notEnabled('SyncEngine') },
  async bootstrapKeyrings() { /* no sync ⇒ nothing to bootstrap from */ },
  buildSyncTransaction() { throw notEnabled('SyncTransaction') },
  buildPresence() { throw notEnabled('collection.presence()') },
}
