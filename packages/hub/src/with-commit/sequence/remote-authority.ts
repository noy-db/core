/**
 * family#206 — remote-authority issuance for `vault.sequence()`.
 *
 * ⛔ INTERNAL, AND DELIBERATELY NOT RE-EXPORTED FROM `index.ts`. That file IS
 * the `@noy-db/hub/sequence` subpath, so anything it exports is PUBLISHED API
 * and frozen by `__tests__/surfaces/sequence.json`. These two helpers are hub's
 * own wiring — a consumer has no use for either, and publishing them would
 * widen a seam for an implementation detail. Same pattern as
 * `with-cargo/floor.ts`. The kernel imports this module by path.
 *
 * ⚠️ `SequenceAuthorityUnavailableError` is published, but from the ROOT BARREL
 * only — which is where `SequenceOfflineError` and `SequenceContentionError`
 * already live. `/sequence` publishes `SequenceNotEnabledError` alone (the
 * opt-in gate's error), and adding a runtime refusal beside it would break that
 * pattern for no benefit: a caller catching this one is using `createNoydb`,
 * not reaching for the subpath.
 */
import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../capsule/index.js'
import { SequenceAuthorityUnavailableError } from '../../kernel/errors.js'
import { SEQUENCE_COLLECTION, type SequenceStore } from './index.js'

/**
 * family#206 — resolve the store a REMOTE-authority series issues from, with
 * the three preconditions that must all hold.
 *
 * ## Authority selection: the sync-peer, and nothing else
 *
 * The caller passes the first **sync-peer** target. It deliberately does NOT
 * pass hub's `primaryTarget` / `syncAdapter`, which falls back to `targets[0]`
 * of any role: on `[{backup}, {sync-peer}]` that selects the archive. core#139
 * fixed exactly that shape for presence, where the symptom was a write nobody
 * reads back; for a counter it would be numbers issued against a push-only
 * store, which is to say numbers no other device can see. A `backup`/`archive`
 * target is push-only by contract, so reading a counter back from one was
 * never part of it. No sync-peer means no authority means the series refuses —
 * the intended outcome, not a degradation.
 *
 * ## Why all three are refusals and none is a fallback
 *
 * A remote-authority series exists because the local counter is per-device.
 * Degrading to it when the authority is unreachable reproduces the duplicate
 * numbers this is meant to prevent, while looking like it worked. For the
 * series people ask this for — fiscal invoice numbers — a duplicate is worse
 * than an outage, so the caller gets an error and retries or queues.
 *
 * ⛔ THE DEK IS CHECKED, NEVER MINTED (ruled on family#206). `getDEK` mints on
 * first access, which is right for a local counter and wrong here: a device
 * that mints its own `_sequences` key seals the SHARED counter under a key the
 * peer cannot unwrap. That surfaces later as an UNREADABLE counter rather than
 * a wrong number — a worse failure, and a confusing one. `_keyring` does
 * replicate, so the remedy is a pull, and the error says so.
 */
export function resolveRemoteSequenceStore(opts: {
  readonly series: string
  readonly target: { store: NoydbStore; label?: string } | null
  /** Memoized store from a previous call, reused when the target still holds. */
  readonly existing: SequenceStore | null
  /** The device's unwrapped DEKs. Read, never written — see above. */
  readonly deks: () => ReadonlyMap<string, unknown>
  /**
   * Whether this vault seals its records. ⚠️ GATES THE DEK PRECONDITION, and
   * it has to: an `encrypt: false` vault never calls `getDEK` at all (see
   * `SequenceStore.read`/`encryptState`, both branch on it), and its keyring
   * carries no collection DEKs — so checking for one would refuse EVERY
   * remote-authority series in unencrypted mode, for a key that is never used.
   */
  readonly encrypted: boolean
  readonly build: (adapter: NoydbStore, getDEK: (collection: string) => Promise<EnclaveKey>) => SequenceStore
}): SequenceStore {
  const { series, target } = opts
  if (target === null) throw new SequenceAuthorityUnavailableError(series, 'no-target')
  if (target.store.capabilities?.casAtomic !== true) {
    throw new SequenceAuthorityUnavailableError(series, 'not-cas', target.label)
  }
  if (opts.encrypted && !opts.deks().has(SEQUENCE_COLLECTION)) {
    throw new SequenceAuthorityUnavailableError(series, 'no-key')
  }
  if (opts.existing) return opts.existing
  return opts.build(target.store, async (collection) => {
    // The eager check above produces the accurate message; this is the
    // backstop for a keyring that changed under a handle the caller already
    // holds, and it names the series this store was first built for. Only ever
    // reached in encrypted mode — see `encrypted` above.
    const dek = opts.deks().get(collection) as EnclaveKey | undefined
    if (dek === undefined) throw new SequenceAuthorityUnavailableError(series, 'no-key')
    return dek
  })
}
