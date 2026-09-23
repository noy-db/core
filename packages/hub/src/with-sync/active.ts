/**
 * Active sync strategy — `withSync()` returns the real implementation
 * that wires the `SyncEngine`, `SyncTransaction`, and `PresenceHandle`
 * constructors into the Noydb / Vault / Collection hot paths.
 *
 * Consumers opt in by:
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withSync } from '@noy-db/hub/sync'
 *
 * const db = await createNoydb({
 *   store: localStore,
 *   sync: remoteStore,
 *   user: ...,
 *   syncStrategy: withSync(),
 * })
 * ```
 *
 * The factory delegates to the existing `sync.ts`,
 * `sync-transaction.ts`, and `presence.ts` modules. Splitting the
 * import chain through this file is what lets tsup tree-shake the
 * ~856 LOC of replication + presence machinery out of the default
 * bundle when no `withSync()` import is present.
 *
 * Keyring + grant/revoke/magic-link/delegation stay in the always-on
 * core (or tree-shake via direct named imports) — those are required
 * for any multi-user vault, even purely local ones.
 *
 * @public
 */

import type { SyncStrategy, BuildSyncEngineOptions } from './strategy.js'
import type { PresenceHandleOpts } from './presence.js'
import type { Vault } from '../kernel/vault.js'
import { SyncEngine } from './engine.js'
import { SyncTransaction } from './transaction.js'
import { PresenceHandle } from './presence.js'
import { bootstrapKeyrings } from './reserved-mirror.js'

/**
 * core#107 — `arbiter: true` makes this device the vault's ARBITER: its
 * admission refusals are replicated so the writer finds out, instead of
 * staying local to the device that judged them.
 *
 * ⚠️ One arbiter, named by configuration on the device that is to be it
 * (the admin host, or the daemon) — ruled over a quorum because the failure
 * mode is legible: no arbiter configured means no replication, which is
 * exactly the pre-core#107 behaviour. It is NOT an authority proof: nothing
 * stops a member hand-writing `_sync_rejections`, and the reason that is
 * tolerable is the report-only ruling — a replicated refusal never deletes,
 * tombstones or retracts anything, so the worst a forged one does is show
 * somebody a notice about their own record.
 *
 * ⚠️ THE CONDITION THAT WOULD MAKE THAT NON-BOUNDARY A REAL ONE, named by
 * pilot-1 when they accepted it: every member is currently staff of the same
 * firm, and a forged refusal is sealed under the refused record's own
 * collection DEK — so a forger can only show a notice about a record they
 * could already read. ⛔ If EXTERNAL `client`-role users ever hold
 * collections of their own, "who may write `_sync_rejections`" stops being
 * cosmetic and this needs an authority design, not a flag. Do not read the
 * paragraph above as a general safety argument; it is an argument about one
 * topology, and this is the trigger to re-open it.
 */
export interface WithSyncOptions {
  readonly arbiter?: boolean
}

export function withSync(options?: WithSyncOptions): SyncStrategy {
  return {
    bootstrapKeyrings,
    buildSyncEngine(opts: BuildSyncEngineOptions): SyncEngine {
      return new SyncEngine({ ...opts, ...(options?.arbiter === true && { arbiter: true }) })
    },
    buildSyncTransaction(vault: Vault, engine: SyncEngine): SyncTransaction {
      return new SyncTransaction(vault, engine)
    },
    buildPresence<P>(opts: PresenceHandleOpts): PresenceHandle<P> {
      return new PresenceHandle<P>(opts)
    },
  }
}
