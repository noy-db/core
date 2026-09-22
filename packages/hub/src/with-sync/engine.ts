import { buildRecordEnvelope, envelopeBodyForHash, buildDeleteMarker } from '../capsule/index.js'
import type {
  NoydbStore,
  DirtyEntry,
  Conflict,
  ConflictStrategy,
  CollectionConflictResolver,
  PushOptions,
  PullOptions,
  PushResult,
  PullResult,
  SyncStatus,
  EncryptedEnvelope,
  SyncMetadata,
  SyncTargetRole,
  ErasureEnforcement,
  SyncProgress,
  RealignResult,
  SyncApplied, SyncRejection, SyncRejectedApi,
  SyncEpochRecord, ReplaceRemoteResult,
} from '../kernel/types.js'
import { NOYDB_SYNC_VERSION } from '../kernel/types.js'
import { isConflictError, ValidationError } from '../kernel/errors.js'
import { pushReserved, pullReserved, pullKeyringFile } from './reserved-mirror.js'

/** core#74 — where a device parks the records its admission gate refused. Local-only: never mirrored, never full-pushed. */
export const REJECTED_COLLECTION = '_sync_rejected'
/** core#74 — the parking record: the refusal and the untouched envelope, plaintext JSON (the envelope inside is still ciphertext). */
interface ParkedRejection { readonly rejection: SyncRejection; readonly envelope: EncryptedEnvelope }
/** The parking record is a plaintext-body envelope; the capsule's canonical body reader returns exactly its JSON. */
function parseParked(env: EncryptedEnvelope): ParkedRejection {
  return JSON.parse(envelopeBodyForHash(env)) as ParkedRejection
}
import type { MergeAuthority } from '../port/with/merge-authority.js'
import type { AdmissionAuthority } from '../port/with/admission-authority.js'
import {
  PERIOD_SUMMARY_COLLECTIONS,
  PERIODS_COLLECTION,
  buildPeriodScope,
  validatePeriodsOption,
  type PeriodPullSource,
} from './period-scope.js'
import type { NoydbEventEmitter } from '../kernel/events.js'
import type { SyncPolicy } from '../kernel/sync-policy.js'
import { SyncScheduler } from '../kernel/sync-policy.js'
import { isTombstoneShape, isDeleteMarker, envelopeBodySize } from '../capsule/index.js'

/** #650 Task 4 (#647) — the declared reserved-lookup (`_dict_*`/`_lookup_*`) collection-name
 *  registry a `SyncEngine` enumerates on pull. Explicit, not a blanket underscore-glob — other
 *  `_`-prefixed namespaces keep their `loadAll`-skip semantics untouched. */
export interface ReservedLookupSource {
  /** Declared reserved-lookup collection names to enumerate on pull. */
  collections(): readonly string[]
}

/** Sync engine: dirty tracking, push, pull, conflict resolution, scheduling. */
export class SyncEngine {
  private readonly mergeAuthority: MergeAuthority | undefined
  /** core#74 — the vault's admission gate for incoming records; wired at open like the other vault seams. */
  private admission: AdmissionAuthority | undefined
  #applied: SyncApplied[] = []
  #rejected: SyncRejection[] = []
  private readonly local: NoydbStore
  private readonly remote: NoydbStore
  private readonly strategy: ConflictStrategy
  private readonly emitter: NoydbEventEmitter
  private readonly vault: string
  readonly role: SyncTargetRole
  readonly label: string | undefined
  /** #948: the resolved policy this engine was constructed with, retained for
   *  introspection (`Noydb.listSyncTargets()`) — otherwise lost once consumed
   *  into the scheduler below. */
  readonly policy: SyncPolicy | undefined

  private dirty: DirtyEntry[] = []
  /** #1036 — last SUCCESSFUL push/pull. Never advanced by a failed attempt. */
  private lastPush: string | null = null
  private lastPull: string | null = null
  /** core#72 — the target's restore epoch this device adopted; null before any. */
  private epoch: number | null = null
  /**
   * #1036 — the failure that ended the most recent attempt, cleared by the next
   * success. Live state only: deliberately NOT persisted in `_sync/meta`, since a
   * reload cannot know whether the target is still failing. It exists so a poller
   * can separate "never synced" (both null) from "synced a while ago, failing
   * since" (`lastPush` set, `lastError` set).
   */
  private lastError: { readonly at: string; readonly op: 'push' | 'pull'; readonly message: string } | null = null
  private loaded = false
  private autoSyncInterval: ReturnType<typeof setInterval> | null = null
  private isOnline = true

  /** Sync scheduler. Manages push/pull timing. */
  readonly scheduler: SyncScheduler | null

  /** Per-collection conflict resolvers registered by Collection instances. */
  private readonly conflictResolvers = new Map<string, CollectionConflictResolver>()

  /**
   * Expands a collection-name filter to include its satellite pair partner(s)
   * (spec #591 convergence rule 5b) — wired from vault satellite declaration
   * via `setPairExpander`. `undefined` when no satellite has ever been
   * declared for this vault: identity behavior, zero change for non-satellite
   * users.
   */
  private pairExpander?: (names: readonly string[]) => readonly string[]

  /** #598: refreshes Collection in-memory views after a sync-applied local write. Wired by the
   *  vault at open. `action` (#640): `'delete'` for a pulled tombstone/delete-marker, `'put'`
   *  otherwise — classified at `applyRemote`, the one choke point that holds the envelope. */
  private cacheInvalidator?: (collection: string, id: string, action: 'put' | 'delete') => Promise<void>

  /** Wire the Collection-cache invalidation hook (#598). Same injection pattern as `setPairExpander`. */
  setCacheInvalidator(fn: (collection: string, id: string, action: 'put' | 'delete') => Promise<void>): void {
    this.cacheInvalidator = fn
  }

  /** #638 Task 4: opens/flushes the vault's graph-dispatch touch batch around a whole `pull()`/
   *  `push()` call, so N `applyRemote`d records feeding the same derivation/rollup/MV target
   *  recompute once. Wired by the vault at open, mirroring `cacheInvalidator`. */
  private graphBatchController?: { begin(): void; flush(): Promise<void> }

  /** Wire the graph-dispatch batch controller (#638 Task 4). Same injection pattern as `setCacheInvalidator`. */
  setGraphBatchController(controller: { begin(): void; flush(): Promise<void> }): void {
    this.graphBatchController = controller
  }

  /** #650 Task 4 (#647): declared reserved-lookup collections `pull()` enumerates explicitly (the
   *  store's `list()` does not skip `_`-prefixed names, unlike `loadAll()`). Wired by the vault at
   *  open, same injection pattern as `setCacheInvalidator`/`setGraphBatchController`. */
  private reservedLookup?: ReservedLookupSource

  /** Wire the reserved-lookup source (#650 Task 4). */
  setReservedLookupSource(source: ReservedLookupSource): void {
    this.reservedLookup = source
  }

  /** #653: expands a (pair-expanded) collection-name filter to include the reserved `_dict_*`
   *  collections those names depend on via their lookup fields — mirrors `pairExpander` so a
   *  partial `push`/`pull({collections:[...]})` never drops the dictionary a named collection's
   *  labels/membership rely on. Wired unconditionally from the vault's `dictKeyFieldRegistry` via
   *  `setReservedDictExpander` (returns `[]` when the vault has no dict-backed collections); only
   *  `undefined` on a standalone engine that was never vault-attached. */
  private reservedDictExpander?: (names: readonly string[]) => readonly string[]

  /** Wire the reserved-dict expansion function (#653). Same injection pattern as `setPairExpander`. */
  setReservedDictExpander(expander: (names: readonly string[]) => readonly string[]): void {
    this.reservedDictExpander = expander
  }

  /** #807: vault-injected source of decrypted period records — resolves the `_ts` windows a
   *  `pull({ periods })` scopes to. Re-read AFTER the summaries phase, so a fresh device's
   *  freshly pulled `_periods` index is what the windows are computed from. `undefined` on a
   *  standalone engine that was never vault-attached (period-scoped pull then throws). */
  private periodPullSource?: PeriodPullSource

  /** Wire the period-window source (#807). Same injection pattern as `setReservedLookupSource`. */
  setPeriodPullSource(source: PeriodPullSource): void {
    this.periodPullSource = source
  }

  /** core#81 — the collections this keyring names; the walk set for a paged pull. Wired by the vault at open. */
  private collectionNames?: () => readonly string[]

  /** Wire the paged-pull walk set (core#81). Same injection pattern as `setCacheInvalidator`. */
  setCollectionNames(fn: () => readonly string[]): void {
    this.collectionNames = fn
  }

  /**
   * core#81 — one chunk per page of one collection, for `pull({ paged: true })`.
   * `listPage` when the store offers it (200 per page), else `list` + `get` in
   * batches of the same size. Never more than one page in memory.
   */
  private async *pagedChunks(names: readonly string[]): AsyncGenerator<[string, Record<string, EncryptedEnvelope>]> {
    const PAGE = 200
    const remote = this.remote
    for (const coll of names) {
      if (typeof remote.listPage === 'function') {
        let cursor: string | undefined
        do {
          const page = await remote.listPage(this.vault, coll, cursor, PAGE)
          const records: Record<string, EncryptedEnvelope> = {}
          for (const { id, envelope } of page.items) records[id] = envelope
          if (page.items.length > 0) yield [coll, records]
          cursor = page.nextCursor ?? undefined
        } while (cursor !== undefined)
      } else {
        const ids = await remote.list(this.vault, coll)
        for (let i = 0; i < ids.length; i += PAGE) {
          const records: Record<string, EncryptedEnvelope> = {}
          for (const id of ids.slice(i, i + PAGE)) {
            const env = await remote.get(this.vault, coll, id)
            if (env) records[id] = env
          }
          if (Object.keys(records).length > 0) yield [coll, records]
        }
      }
    }
  }

  /** core#82 — when a pull replaces the caller's OWN keyring file, the vault reloads it in place. */
  private rosterReload?: { userId: string; reload: () => Promise<void> }

  /** Wire the roster-reload seam (core#82). Same injection pattern as `setCacheInvalidator`. */
  /** core#74 — wire the vault's admission gate. */
  setAdmission(a: AdmissionAuthority): void {
    this.admission = a
  }

  /** core#71 — after `vault.load()`: a new base. Drops the dirty log, the watermarks and the adopted epoch. */
  async resetAfterRestore(): Promise<void> {
    await this.ensureLoaded()
    this.dirty = []
    this.lastPush = null
    this.lastPull = null
    this.epoch = null
    await this.persistMeta()
  }

  /** core#72 — the target's epoch record, or null when the target was never replaced. */
  async #remoteEpoch(): Promise<SyncEpochRecord | null> {
    const env = await this.remote.get(this.vault, '_sync', 'epoch')
    return env ? (JSON.parse(envelopeBodyForHash(env)) as SyncEpochRecord) : null
  }

  /**
   * core#72 — make the LOCAL vault authoritative on this target. Every local
   * record goes up unconditionally, re-sealed above the target's version where
   * the target moved on (so every peer's copy is superseded); every id the
   * target holds that the local vault lacks gets a delete marker at
   * `remote._v + 1` (so every peer removes it); the reserved collections are
   * mirrored; then a new epoch is written at `_sync/epoch`. The dirty log is
   * cleared: the target IS the local state now.
   */
  async replaceRemote(): Promise<ReplaceRemoteResult> {
    await this.ensureLoaded()
    const actor = this.rosterReload?.userId ?? 'sync'
    const [localSnapshot, remoteSnapshot] = await Promise.all([this.local.loadAll(this.vault), this.remote.loadAll(this.vault)])
    let replaced = 0
    let tombstoned = 0
    for (const [collection, records] of Object.entries(localSnapshot)) {
      if (collection === REJECTED_COLLECTION) continue
      for (const [id, envelope] of Object.entries(records)) {
        const current = remoteSnapshot[collection]?.[id]
        let out = envelope
        if (current && current._v >= envelope._v) {
          // The target moved past the local copy: lift the local envelope above
          // it, re-sealed through the merge authority (the AAD binds `_v`).
          out = this.mergeAuthority
            ? await this.mergeAuthority.advance(collection, id, envelope, current._v + 1)
            : { ...envelope, _v: current._v + 1 }
          await this.local.put(this.vault, collection, id, out)
        }
        await this.remote.put(this.vault, collection, id, out)
        replaced++
      }
    }
    for (const [collection, records] of Object.entries(remoteSnapshot)) {
      if (collection === REJECTED_COLLECTION) continue
      for (const [id, envelope] of Object.entries(records)) {
        if (localSnapshot[collection]?.[id] !== undefined) continue
        if (isTombstoneShape(envelope) || isDeleteMarker(envelope)) continue
        const marker = buildDeleteMarker({ collection, id }, envelope._v + 1, actor)
        await this.remote.put(this.vault, collection, id, marker)
        await this.local.put(this.vault, collection, id, marker) // the local mirrors the target exactly: its own next pull brings nothing back
        tombstoned++
      }
    }
    const mirrored = await pushReserved(this.local, this.remote, this.vault)
    const previous = await this.#remoteEpoch()
    const epoch = (previous?.epoch ?? 0) + 1
    const record: SyncEpochRecord = { epoch, at: new Date().toISOString(), by: actor, replaced, tombstoned }
    await this.remote.put(this.vault, '_sync', 'epoch', buildRecordEnvelope({ collection: '_sync', id: 'epoch', version: epoch }, { iv: '', data: JSON.stringify(record) }))
    this.dirty = []
    this.epoch = epoch
    this.lastPush = new Date().toISOString()
    await this.persistMeta()
    const result: ReplaceRemoteResult = { epoch, replaced, tombstoned, reserved: mirrored.copied }
    this.emitter.emit('sync:replace', { vault: this.vault, ...result })
    return result
  }

  /**
   * core#72 — at the start of a pull: has the target been replaced since this
   * device last synced? If so, park every unpushed local edit (same fate as an
   * admission refusal, reason `restore-epoch`), drop the dirty log, adopt the
   * epoch. The pull that follows then adopts the target: the restorer lifted
   * its records above every peer's version and tombstoned what it removed.
   */
  async #crossEpoch(): Promise<{ epoch: number; resynced: boolean; parked: number }> {
    const remote = await this.#remoteEpoch()
    if (!remote || remote.epoch === this.epoch) return { epoch: remote?.epoch ?? 0, resynced: false, parked: 0 }
    const from = this.epoch
    let parked = 0
    for (const entry of this.dirty) {
      if (entry.action === 'delete') continue
      const env = await this.local.get(this.vault, entry.collection, entry.id)
      if (!env) continue
      const rejection: SyncRejection = {
        vault: this.vault, collection: entry.collection, id: entry.id, version: env._v,
        reason: `restore-epoch: the target was replaced (epoch ${remote.epoch}) after this edit; readmit to keep it locally, then put again to push`,
        ...(env._by !== undefined ? { by: env._by } : {}), at: new Date().toISOString(),
      }
      const parkedRecord: ParkedRejection = { rejection, envelope: env }
      await this.local.put(this.vault, REJECTED_COLLECTION, `${entry.collection}::${entry.id}`,
        buildRecordEnvelope({ collection: REJECTED_COLLECTION, id: `${entry.collection}::${entry.id}`, version: 1 }, { iv: '', data: JSON.stringify(parkedRecord) }))
      this.#rejected.push(rejection)
      this.emitter.emit('sync:rejected', rejection)
      // Adopting the target WHOLESALE: the unpushed record leaves the local
      // store too (the parking record holds it; `readmit` puts it back).
      await this.local.delete(this.vault, entry.collection, entry.id)
      await this.cacheInvalidator?.(entry.collection, entry.id, 'delete')
      parked++
    }
    this.dirty = []
    this.epoch = remote.epoch
    this.emitter.emit('sync:epoch', { vault: this.vault, from, to: remote.epoch, parked })
    return { epoch: remote.epoch, resynced: true, parked }
  }

  /** core#74 — the parked refusals on this device, and their two fates. */
  rejected(): SyncRejectedApi {
    const key = (collection: string, id: string): string => `${collection}::${id}`
    return {
      list: async () => {
        const out: SyncRejection[] = []
        for (const id of await this.local.list(this.vault, REJECTED_COLLECTION)) {
          const env = await this.local.get(this.vault, REJECTED_COLLECTION, id)
          if (!env) continue
          out.push(parseParked(env).rejection)
        }
        return out
      },
      readmit: async (collection, id) => {
        const env = await this.local.get(this.vault, REJECTED_COLLECTION, key(collection, id))
        if (!env) throw new ValidationError(`sync: no rejected record parked for "${collection}/${id}".`)
        await this.local.put(this.vault, collection, id, parseParked(env).envelope)
        await this.local.delete(this.vault, REJECTED_COLLECTION, key(collection, id))
        await this.cacheInvalidator?.(collection, id, 'put')
      },
      discard: async (collection, id) => {
        await this.local.delete(this.vault, REJECTED_COLLECTION, key(collection, id))
      },
    }
  }

  setRosterReload(seam: { userId: string; reload: () => Promise<void> }): void {
    this.rosterReload = seam
  }

  /** core#81 — the running sync's latest progress sample; `null` when idle. Read by `status()`. */
  private inFlight: SyncProgress | null = null
  private progressLastEmit = 0
  private progressLastRecords = 0

  /** Emit `sync:progress` no more than every 25 records or ~250 ms; `force` for the final sample. */
  private progress(sample: SyncProgress, force = false): void {
    this.inFlight = sample
    const now = Date.now()
    if (!force && sample.records - this.progressLastRecords < 25 && now - this.progressLastEmit < 250) return
    this.progressLastEmit = now
    this.progressLastRecords = sample.records
    this.emitter.emit('sync:progress', sample)
  }

  private progressDone(): void {
    this.inFlight = null
    this.progressLastEmit = 0
    this.progressLastRecords = 0
  }

  /** #807: KPI accumulator `applyRemote` feeds during a period-scoped `pull()` — pointed at the
   *  active phase's counters (summaries → records) and cleared before pull returns. Approximate
   *  by design: a push interleaved mid-pull on the same engine would attribute its converge
   *  applies to the open phase; the counters are a download-budget KPI, not an audit source. */
  private pullByteSink: { records: number; bytes: number } | null = null
  /** core#81 — ciphertext bytes applied by the running pull, for `sync:progress`. */
  private pullBytes = 0

  constructor(opts: {
    local: NoydbStore
    remote: NoydbStore
    vault: string
    strategy: ConflictStrategy
    emitter: NoydbEventEmitter
    syncPolicy?: SyncPolicy
    role?: SyncTargetRole
    label?: string
    /**
     * #1042 — the merge's verify/re-stamp capability. Optional so an engine
     * built without one behaves exactly as before; the Vault supplies it.
     *
     * A closure, not an import: `with-sync` is DEK-free and
     * `check:architecture` enforces that, so the capability arrives already
     * bound to the keys rather than the engine reaching for them.
     */
    mergeAuthority?: MergeAuthority
  }) {
    this.local = opts.local
    this.remote = opts.remote
    this.vault = opts.vault
    this.strategy = opts.strategy
    this.emitter = opts.emitter
    this.role = opts.role ?? 'sync-peer'
    this.label = opts.label
    this.policy = opts.syncPolicy
    this.mergeAuthority = opts.mergeAuthority

    // Create a scheduler when the policy asks for ANY automatic behaviour.
    // #897: this used to test `push.mode !== 'manual'` alone, so a policy of
    // `{ push: manual, pull: interval }` silently got no scheduler and its pull
    // mode was ignored.
    const policy = opts.syncPolicy
    if (policy && (policy.push.mode !== 'manual' || policy.pull.mode !== 'manual')) {
      this.scheduler = new SyncScheduler(policy, {
        push: () => this.push().then(() => {}),
        // #618 — role-gate the SCHEDULER-INITIATED pull. The Noydb layer gates
        // pull-from-sink for explicit calls, but the scheduler calls the engine
        // directly and would bypass it: a backup/archive-only primary with an
        // `interval`/`on-focus` pull policy would pull ungated, reintroducing
        // #616. This guards the engine self-initiating on a timer; an explicit
        // `engine.pull()` still pulls for every role.
        // `collections` is set by a 'phased' sequence — one collection per phase.
        // A role-gated skip reports 'incomplete': nothing was pulled, so the
        // phase must not mark its collection ready.
        pull: (collections) =>
          this.role === 'sync-peer'
            ? this.pull(collections ? { collections: [...collections] } : undefined)
                // PullResult.errors accumulates WITHOUT throwing, so a partial
                // failure is only visible here — not via a rejected promise.
                .then(r => (r.errors.length === 0 ? 'complete' : 'incomplete'))
            : Promise.resolve('incomplete'),
        getDirtyCount: () => this.dirty.length,
      })
    } else {
      this.scheduler = null
    }
  }

  /** Start the sync scheduler. Called after vault is fully opened. */
  startScheduler(): void {
    this.scheduler?.start()
  }

  /** Stop the sync scheduler. Called on close. */
  stopScheduler(): void {
    this.scheduler?.stop()
  }

  /**
   * Register a per-collection conflict resolver.
   * Called by Collection when `conflictPolicy` is set.
   *
   * Pair-coupled (#591 rule 5b): registering for one satellite-pair member
   * registers the same resolver for both — the pair converges under one
   * resolution policy. Expands with whatever the pair-expander knows *at this
   * call*; resolvers registered before their pair existed are covered by
   * `remirrorPairResolvers` at pair-registration time.
   */
  registerConflictResolver(collection: string, resolver: CollectionConflictResolver): void {
    for (const n of this.pairExpander?.([collection]) ?? [collection]) this.conflictResolvers.set(n, resolver)
  }

  /**
   * Wire a satellite pair-expansion function (vault registration, #591 Task 11).
   * The closure re-reads the live `SatelliteRegistry` on every call, so pairs
   * declared after this is set are still picked up by `push`/`pull` filters.
   */
  setPairExpander(expander: (names: readonly string[]) => readonly string[]): void {
    this.pairExpander = expander
  }

  /**
   * Retroactively mirror per-collection conflict resolvers across a newly
   * registered satellite pair (#591 rule 5b) — covers the NORMAL declaration
   * order, where the base's `conflictPolicy` resolver was registered before
   * the satellite was declared (so the call-time expansion in
   * `registerConflictResolver` saw no pair yet). Tie-break: when BOTH members
   * already carry (different) resolvers, the FIRST name in `names` wins —
   * callers pass `[base, satellite]`, so the base's resolver is canonical.
   * Idempotent; a later explicit registration on either member still
   * overwrites both (last-wins, via the call-time expansion above).
   */
  remirrorPairResolvers(names: readonly string[]): void {
    const canonical = names.map(n => this.conflictResolvers.get(n)).find(r => r !== undefined)
    if (!canonical) return
    for (const n of names) this.conflictResolvers.set(n, canonical)
  }

  /** Record a local change for later push. */
  async trackChange(collection: string, id: string, action: DirtyEntry['action'], version: number): Promise<void> {
    await this.ensureLoaded()

    // Deduplicate: if same collection+id already in dirty, update it
    const idx = this.dirty.findIndex(d => d.collection === collection && d.id === id)
    const entry: DirtyEntry = {
      vault: this.vault,
      collection,
      id,
      action,
      version,
      timestamp: new Date().toISOString(),
    }

    if (idx >= 0) {
      this.dirty[idx] = entry
    } else {
      this.dirty.push(entry)
    }

    await this.persistMeta()

    // Notify scheduler of the write (triggers on-change or debounce)
    this.scheduler?.notifyChange()
  }

  /** Remove a dirty entry (satellite fan-out revert cleanup — spec #591). */
  async removeDirty(collection: string, id: string): Promise<void> {
    const before = this.dirty.length
    this.dirty = this.dirty.filter(d => !(d.collection === collection && d.id === id))
    if (this.dirty.length !== before) await this.persistMeta()
  }

  /** One dirty entry of `push()`: the CAS put, the tombstone assertion, the delete, and every conflict branch. Extracted so `push({ concurrency })` can run entries in a bounded pool (core#93). */
  async #pushOne(i: number, entry: DirtyEntry, acc: { pushed: number; bytes: number; completed: number[]; conflicts: Conflict[]; erasures: ErasureEnforcement[]; errors: Error[] }): Promise<void> {
  try {
    if (entry.action === 'delete') {
      await this.remote.delete(this.vault, entry.collection, entry.id)
      acc.completed.push(i)
      acc.pushed++
    } else {
      const envelope = await this.local.get(this.vault, entry.collection, entry.id)
      if (!envelope) {
        // Record was deleted locally after being marked dirty
        acc.completed.push(i)
        return
      }

      if (isTombstoneShape(envelope)) {
        // #590: a tombstone push is an erasure assertion — unconditional,
        // no CAS, no conflict resolution. Erasure always wins.
        await this.remote.put(this.vault, entry.collection, entry.id, envelope)
        acc.completed.push(i)
        acc.pushed++
        return
      }

      try {
        await this.remote.put(
          this.vault,
          entry.collection,
          entry.id,
          envelope,
          // core#100 — a `rekey` re-encrypted the record in place: same `_v`,
          // new bytes; the target still at that version takes it.
          entry.action === 'rekey' ? entry.version : entry.version - 1,
        )
        acc.completed.push(i)
        acc.pushed++
        acc.bytes += envelopeBodySize(envelope) // core#81
      } catch (err) {
        if (isConflictError(err)) {
          const remoteEnvelope = await this.remote.get(this.vault, entry.collection, entry.id)
          if (remoteEnvelope) {
            if (remoteEnvelope._v === envelope._v && envelopeBodyForHash(remoteEnvelope) === envelopeBodyForHash(envelope)) {
              // core#71 (pilot-1's restore run) — the target already holds THIS
              // envelope: a `push({ full: true })` after a restore, or a replay.
              // The CAS refused it because the remote is at the version we
              // expected to advance past; nothing to resolve, nothing to report.
              acc.completed.push(i)
            } else if (isTombstoneShape(remoteEnvelope)) {
              // #590: remote already shredded this record — enforce locally,
              // never resolve. Resolvers must not overrule an erasure.
              await this.applyRemote(entry.collection, entry.id, remoteEnvelope)
              acc.erasures.push(this.reportErasure(entry.collection, entry.id, remoteEnvelope, envelope, 'push'))
              acc.completed.push(i)
            } else if (
              remoteEnvelope._v === envelope._v &&
              isDeleteMarker(remoteEnvelope) !== isDeleteMarker(envelope) &&
              !this.conflictResolvers.get(entry.collection)
            ) {
              // #589: a same-_v delete-vs-edit tie on the push channel. handleConflict's db-level
              // 'version' default would resolve it to local-wins; the tie rule consults ONLY the
              // per-collection resolver, else delete-wins. (When a per-collection resolver IS set,
              // fall through to handleConflict, which already honors it — incl. the merged case.)
              if (isDeleteMarker(remoteEnvelope)) {
                // remote already deleted → converge locally, drop our (edit) push
                await this.applyRemote(entry.collection, entry.id, remoteEnvelope)
                acc.completed.push(i)
              } else {
                // our local is the marker → force the delete onto the remote (unconditional put)
                await this.remote.put(this.vault, entry.collection, entry.id, envelope)
                acc.completed.push(i)
                acc.pushed++
              }
            } else {
              const { handled, conflict } = await this.handleConflict(
                entry.collection,
                entry.id,
                envelope,
                remoteEnvelope,
                'push',
              )
              acc.conflicts.push(conflict)
              if (handled === 'local') {
                // #936: supersede, don't overwrite in place — see advancePastRemote.
                const winner = await this.advancePastRemote(conflict.local, entry.collection, entry.id, remoteEnvelope)
                await this.remote.put(this.vault, entry.collection, entry.id, winner)
                if (winner !== conflict.local) await this.applyRemote(entry.collection, entry.id, winner, { admit: false })
                acc.completed.push(i)
                acc.pushed++
              } else if (handled === 'remote') {
                await this.applyRemote(entry.collection, entry.id, conflict.remote)
                acc.completed.push(i)
              } else if (handled === 'merged' && conflict.local !== envelope) {
                // Merged envelope is stored in conflict.local (the winner)
                const merged = conflict.local
                await this.remote.put(this.vault, entry.collection, entry.id, merged)
                await this.applyRemote(entry.collection, entry.id, merged)
                acc.completed.push(i)
                acc.pushed++
              }
              // handled === 'deferred': leave in dirty log
            }
          }
        } else {
          throw err
        }
      }
    }
    } catch (err) {
      acc.errors.push(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * core#92 — mark every user-collection record in the local store dirty at its
   * current version, so the next push sends it (CAS against `_v - 1`, so a
   * remote that already holds a newer copy resolves through the conflict path
   * instead of being overwritten). Records already dirty keep their entry.
   */
  async markAllDirty(): Promise<void> {
    await this.ensureLoaded()
    const snapshot = await this.local.loadAll(this.vault)
    for (const [collection, records] of Object.entries(snapshot)) {
      if (collection === REJECTED_COLLECTION) continue // core#74 — parked refusals are this device's alone
      for (const [id, envelope] of Object.entries(records)) {
        if (this.dirty.some(d => d.collection === collection && d.id === id)) continue
        this.dirty.push({ vault: this.vault, collection, id, action: 'put', version: envelope._v, timestamp: new Date().toISOString() })
      }
    }
    await this.persistMeta()
  }

  /** Push dirty records to remote adapter. Accepts optional `PushOptions` for partial sync. */
  async push(options?: PushOptions): Promise<PushResult> {
    await this.ensureLoaded()
    if (options?.full) await this.markAllDirty()
    this.graphBatchController?.begin() // #638 Task 4

    let reserved = 0
    const conflicts: Conflict[] = []
    const erasures: ErasureEnforcement[] = []
    const errors: Error[] = []
    const completed: number[] = []

    // Partial sync: expand the filter to cover satellite pair partners (#591 rule 5b), then the
    // reserved `_dict_*` collections those (expanded) names depend on (#653) — a locally-dirty
    // dict edit pushes alongside push({collections:['orders']}), symmetric with pull below.
    const expanded = options?.collections ? (this.pairExpander?.(options.collections) ?? options.collections) : null
    const filter = expanded ? new Set([...expanded, ...(this.reservedDictExpander?.(expanded) ?? [])]) : null

    const pushTotal = filter ? this.dirty.filter(d => filter.has(d.collection)).length : this.dirty.length
    const acc = { pushed: 0, bytes: 0, completed, conflicts, erasures, errors }
    const eligible = [...this.dirty.keys()].filter(i => !filter || filter.has(this.dirty[i]!.collection))
    const width = Math.max(1, Math.floor(options?.concurrency ?? 1))
    // core#93 — a bounded pool: `width` entries in flight, each with its own CAS
    // and conflict path. width 1 is exactly the previous serial loop.
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < eligible.length) {
        const i = eligible[next++]!
        this.progress({ direction: 'push', phase: 'records', records: acc.pushed, bytes: acc.bytes, total: { records: pushTotal } })
        await this.#pushOne(i, this.dirty[i]!, acc)
      }
    }
    await Promise.all(Array.from({ length: Math.min(width, eligible.length) }, () => worker()))
    const pushed = acc.pushed
    const pushBytes = acc.bytes

    // Remove completed entries from dirty log (reverse order to preserve indices)
    for (const i of completed.sort((a, b) => b - a)) {
      this.dirty.splice(i, 1)
    }

    // core#75 / core#83 — the target is a FULL replica only if it carries the
    // roster and the other declared reserved records (see reserved-mirror.ts).
    // They are written outside the dirty log, so they are mirrored here by
    // their own ordering (higher wins, absent receives), every push, every
    // role: a `backup` must be restorable too. Revocations travel through the
    // dirty loop above as `(collection, id, 'delete')`.
    // Not counted in `pushed`: that is a RECORD count, and consumers assert on it.
    if (!filter) {
      this.progress({ direction: 'push', phase: 'reserved', records: pushed, bytes: pushBytes, total: { records: pushTotal } })
      try {
        const mirrored = await pushReserved(this.local, this.remote, this.vault)
        reserved = mirrored.copied
        // core#96 (pilot-1, finding B) — a local keyring the target supersedes
        // was discarded by the epoch rule; say so, as a conflict on `_keyring`.
        for (const stale of mirrored.staleKeyrings ?? []) {
          conflicts.push({
            vault: this.vault, collection: '_keyring', id: stale.id, local: stale.local, remote: stale.remote,
            localVersion: stale.local._v, remoteVersion: stale.remote._v,
          })
        }
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }
    this.progress({ direction: 'push', phase: 'records', records: pushed, bytes: pushBytes, total: { records: pushTotal } }, true)
    this.progressDone()

    this.recordOutcome('push', errors)
    try {
      await this.persistMeta()
    } finally {
      // #644 item 1: flush (which clears `_graphBatch` unconditionally, vault.ts:1316-1320) must
      // run even if `persistMeta()` throws — else a throw here leaves the batch open, corrupting
      // the NEXT pull()/push() call's wave with THIS call's stale touches.
      await this.graphBatchController?.flush() // #638 Task 4
    }

    const result: PushResult = { pushed, conflicts, errors, erasures, ...(reserved > 0 && { reserved }) }
    this.emitter.emit('sync:push', result)
    return result
  }

  /** Pull remote records to local adapter. Accepts optional `PullOptions` for partial sync. */
  async pull(options?: PullOptions): Promise<PullResult> {
    await this.ensureLoaded()

    let pulled = 0
    let reserved = 0
    this.#applied = []
    this.#rejected = []
    const conflicts: Conflict[] = []
    const errors: Error[] = []
    // core#72 — before the reserved phase and before any record. An unreachable
    // target is a pull error like any other, not a throw out of `pull()`.
    let crossed = { epoch: 0, resynced: false, parked: 0 }
    try {
      crossed = await this.#crossEpoch()
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)))
    }
    const erasures: ErasureEnforcement[] = []

    // core#75 / core#83 — the reserved set comes FIRST, before any record: a
    // device that bootstrapped from this target on open already holds its own
    // keyring file, but a grant or narrowing made elsewhere since must land
    // before the records it gates, and an invite audit doc before the accept
    // that needs it. A local record the remote lacks is a revocation — unless
    // the remote has never carried that collection, or a pending local write
    // protects it. If the caller's OWN keyring file was replaced, the vault
    // reloads it in place (core#82) — no reopen.
    if (!options?.collections) {
      this.progress({ direction: 'pull', phase: 'reserved', records: 0, bytes: 0 })
      try {
        const protectedIds = new Map<string, Set<string>>()
        for (const d of this.dirty) {
          if (d.action === 'delete') continue
          let set = protectedIds.get(d.collection)
          if (!set) { set = new Set(); protectedIds.set(d.collection, set) }
          set.add(d.id)
        }
        const mirrored = await pullReserved(this.remote, this.local, this.vault, protectedIds)
        reserved = mirrored.copied + mirrored.deleted
        if (this.rosterReload && mirrored.keyringsCopied.includes(this.rosterReload.userId)) await this.rosterReload.reload()
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }

    // ── #807 period-scoped pull: validate the option, sync the period summaries
    // (`_periods` + companions — the navigation index, ALWAYS pulled in full,
    // exempt from every filter), then resolve the selected `_ts` windows from the
    // freshly synced index. All BEFORE the graph batch opens, so an invalid
    // option throws without leaving a batch dangling; summary applies route
    // through `applyRemote` like any pull (reserved names have no Collection
    // instance, so the invalidator/graph seams are no-ops for them). ──
    let periodScope: ((envelope: EncryptedEnvelope) => boolean) | null = null
    let phases: { summaries: { records: number; bytes: number }; records: { records: number; bytes: number } } | null = null
    if (options?.periods !== undefined) {
      validatePeriodsOption(options.periods)
      if (!this.periodPullSource) {
        throw new ValidationError(
          'period-scoped pull requires a vault-attached sync engine (open the vault via createNoydb + openVault).',
        )
      }
      phases = { summaries: { records: 0, bytes: 0 }, records: { records: 0, bytes: 0 } }
      let remotePeriodCount = 0
      this.pullByteSink = phases.summaries
      try {
        for (const collName of PERIOD_SUMMARY_COLLECTIONS) {
          for (const id of await this.remote.list(this.vault, collName)) {
            if (collName === PERIODS_COLLECTION) remotePeriodCount++
            try {
              const remoteEnvelope = await this.remote.get(this.vault, collName, id)
              if (!remoteEnvelope) continue
              const localEnvelope = await this.local.get(this.vault, collName, id)
              if (!localEnvelope || this.#remoteSupersedes(collName, id, remoteEnvelope, localEnvelope)) {
                await this.applyRemote(collName, id, remoteEnvelope)
                pulled++
              }
            } catch (err) {
              errors.push(err instanceof Error ? err : new Error(String(err)))
            }
          }
        }
      } finally {
        this.pullByteSink = null
      }
      const periodRecords = await this.periodPullSource.periods()
      if (remotePeriodCount > 0 && periodRecords.length === 0) {
        throw new ValidationError(
          'period-scoped pull: the vault holds _periods records but none are readable — enable the ' +
            'periods service (`periodsStrategy: withPeriods()`) so pull can resolve the period windows.',
        )
      }
      periodScope = buildPeriodScope(options.periods, periodRecords)
    }

    this.graphBatchController?.begin() // #638 Task 4
    if (phases) this.pullByteSink = phases.records

    // Partial sync: expand the filter to cover satellite pair partners (#591 rule 5b), then the
    // reserved `_dict_*` collections those (expanded) names depend on (#653) — adopters never
    // name `_dict_*` in a `collections` filter, so a named collection's lookup-field dependency
    // must be pulled alongside it or its labels/membership go stale.
    const expanded = options?.collections ? (this.pairExpander?.(options.collections) ?? options.collections) : null
    const filter = expanded ? new Set([...expanded, ...(this.reservedDictExpander?.(expanded) ?? [])]) : null

    try {
      // core#81 — two ways to walk the remote. Default: one `loadAll()`, the
      // total known once the snapshot is down, progress measuring the APPLY
      // phase. Paged: the collections this keyring names (∩ the filter), one
      // page in memory at a time, the total counted by `list()` BEFORE the
      // first apply. Same loop body either way.
      let pullTotal = 0
      let chunks: Iterable<[string, Record<string, EncryptedEnvelope>]> | AsyncIterable<[string, Record<string, EncryptedEnvelope>]>
      if (options?.paged) {
        const known = new Set(this.collectionNames?.() ?? [])
        for (const name of filter ?? []) if (!name.startsWith('_')) known.add(name)
        const names = [...known].filter(n => !n.startsWith('_') && (!filter || filter.has(n)))
        for (const name of names) pullTotal += (await this.remote.list(this.vault, name)).length
        chunks = this.pagedChunks(names)
      } else {
        const remoteSnapshot = await this.remote.loadAll(this.vault)
        for (const [collName, records] of Object.entries(remoteSnapshot)) {
          if (filter && !filter.has(collName)) continue
          pullTotal += Object.keys(records).length
        }
        chunks = Object.entries(remoteSnapshot)
      }
      const pullSample = (): SyncProgress => ({
        direction: 'pull', phase: 'records', records: pulled, bytes: this.pullBytes, total: { records: pullTotal },
      })

      for await (const [collName, records] of chunks) {
        // Partial sync: skip collections not in the filter
        if (filter && !filter.has(collName)) {
          continue
        }

        for (const [id, remoteEnvelope] of Object.entries(records)) {
          this.progress(pullSample())
          // Partial sync: modifiedSince filter — arriving tombstones are exempt (#590):
          // an erasure must never be skipped by partial sync.
          if (
            options?.modifiedSince &&
            remoteEnvelope._ts <= options.modifiedSince &&
            !isTombstoneShape(remoteEnvelope) &&
            !isDeleteMarker(remoteEnvelope)
          ) {
            continue
          }

          // #807: period scope — a record whose `_ts` falls outside every selected
          // window is skipped. Tombstones and delete markers are ALWAYS in scope
          // (built into the predicate): an erasure or delete must never be skipped
          // by partial sync, mirroring the modifiedSince exemption above — that is
          // what lets a device that never pulled a period backfill it later without
          // resurrecting its deleted records.
          if (periodScope !== null && !periodScope(remoteEnvelope)) {
            continue
          }

          try {
            const localEnvelope = await this.local.get(this.vault, collName, id)
            const remoteIsTombstone = isTombstoneShape(remoteEnvelope)

            if (!localEnvelope) {
              // New record from remote (tombstones included — durable erasure evidence)
              await this.applyRemote(collName, id, remoteEnvelope)
              pulled++
            } else if (isTombstoneShape(localEnvelope)) {
              if (remoteIsTombstone) {
                // Both shredded — keep the higher version counter
                if (remoteEnvelope._v > localEnvelope._v) await this.applyRemote(collName, id, remoteEnvelope)
              } else {
                // Terminal rule (#590): a tombstone is never overwritten by a live
                // envelope, regardless of _v. Re-assert the shred outward instead.
                erasures.push(await this.reassertTombstone(collName, id, localEnvelope, remoteEnvelope))
              }
            } else if (remoteIsTombstone) {
              // Terminal rule (#590): an arriving tombstone wins over any local live
              // envelope — even a newer, dirty one. Resolvers are never consulted.
              const wasDirty = this.dirty.some(d => d.collection === collName && d.id === id)
              await this.applyRemote(collName, id, remoteEnvelope)
              this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
              pulled++
              if (wasDirty) erasures.push(this.reportErasure(collName, id, remoteEnvelope, localEnvelope, 'pull'))
            } else if (
              remoteEnvelope._v === localEnvelope._v &&
              isDeleteMarker(remoteEnvelope) !== isDeleteMarker(localEnvelope)
            ) {
              // #589: true concurrent delete-vs-edit at the SAME version. Version order
              // can't break the tie. A per-collection resolver decides if one is set;
              // otherwise DELETE wins (the db-level 'version' default is deliberately NOT
              // consulted — it would resolve a tie to local-wins).
              const resolver = this.conflictResolvers.get(collName)
              if (resolver) {
                const winner = await resolver(id, localEnvelope, remoteEnvelope)
                if (winner !== localEnvelope && winner !== null) {
                  // #589 (review): a novel/merged winner (neither side verbatim) must also be
                  // pushed to remote — mirrors handleConflict's 'merged' handling — so both
                  // sides converge instead of local applying it while remote keeps its old copy.
                  if (winner !== remoteEnvelope) {
                    await this.remote.put(this.vault, collName, id, winner)
                  }
                  await this.applyRemote(collName, id, winner)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                }
                // winner === localEnvelope or null → keep local (its dirty entry, if any, pushes out)
              } else if (isDeleteMarker(remoteEnvelope)) {
                // no resolver → delete wins; the incoming marker is the delete
                await this.applyRemote(collName, id, remoteEnvelope)
                this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                pulled++
              }
              // no resolver and LOCAL is the marker → keep local marker; its dirty 'put' pushes it outward
            } else if (this.#remoteSupersedes(collName, id, remoteEnvelope, localEnvelope)) {
              // Remote is newer — check if we have a dirty entry for this
              const isDirty = this.dirty.some(d => d.collection === collName && d.id === id)
              if (isDirty) {
                // Both changed — conflict
                const { handled, conflict } = await this.handleConflict(
                  collName,
                  id,
                  localEnvelope,
                  remoteEnvelope,
                  'pull',
                )
                conflicts.push(conflict)
                if (handled === 'remote') {
                  await this.applyRemote(collName, id, conflict.remote)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                } else if (handled === 'merged' && conflict.local !== localEnvelope) {
                  const merged = conflict.local
                  await this.applyRemote(collName, id, merged)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                }
                // 'local' or 'deferred': push handles it
              } else {
                // Remote is newer, no local changes — update
                await this.applyRemote(collName, id, remoteEnvelope)
                pulled++
              }
            }
            // Same version or local is newer — skip (push will handle)
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)))
          }
        }
      }

      // #650 Task 4 (#647) — reserved lookup collections (`_dict_*`/`_lookup_*`) are invisible to
      // `remote.loadAll()` above (the store contract skips `_`-prefixed names) but DO sync via
      // this EXPLICIT, declared registry — not a blanket underscore-glob; other `_` namespaces
      // keep their `loadAll`-skip semantics untouched. Applied through the SAME `applyRemote` path,
      // still inside this try block, BEFORE `persistMeta`/`flush` below — so a pulled vocabulary
      // row lands before the wave (flushed at the end of `pull()`) recomputes any dependent.
      //
      // #647 fix wave 1: `LookupHandle.delete()`/`rename()` now write a version-ordered
      // delete-marker row (mirroring #589) instead of a raw adapter delete, so a removed key is
      // a normal row here too — reachable via `remote.list()` like any other id, applied by
      // version like any other write. The only reserved-tier-specific rule is the same-version
      // tie-break below: reserved lookups have no per-collection conflict-resolver concept
      // (dictionaries are admin-edited, not multi-actor-negotiated), so a converging delete
      // unconditionally wins over a same-version live edit.
      //
      // #807: the period scope deliberately does NOT apply here — vocabularies/config rows are
      // not period-partitioned data (a thin client's lookups must be complete regardless of
      // which periods it pulled), the same always-pull rule as the `_periods` summaries phase.
      for (const collName of this.reservedLookup?.collections() ?? []) {
        if (filter && !filter.has(collName)) continue
        for (const id of await this.remote.list(this.vault, collName)) {
          try {
            const remoteEnvelope = await this.remote.get(this.vault, collName, id)
            if (!remoteEnvelope) continue

            // Partial sync: modifiedSince filter — a delete marker is exempt, mirroring the
            // main loop's tombstone/marker exemption above: a deletion must never be silently
            // skipped by a time-window partial pull.
            if (
              options?.modifiedSince &&
              remoteEnvelope._ts <= options.modifiedSince &&
              !isDeleteMarker(remoteEnvelope)
            ) {
              continue
            }

            const localEnvelope = await this.local.get(this.vault, collName, id)
            if (!localEnvelope) {
              await this.applyRemote(collName, id, remoteEnvelope)
              pulled++
            } else if (
              remoteEnvelope._v === localEnvelope._v &&
              isDeleteMarker(remoteEnvelope) !== isDeleteMarker(localEnvelope)
            ) {
              // Same-version delete-vs-edit tie (#589's rule, reserved-tier default: no
              // resolver concept here, so delete always wins).
              if (isDeleteMarker(remoteEnvelope)) {
                await this.applyRemote(collName, id, remoteEnvelope)
                this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                pulled++
              }
              // else: local already holds the marker (a local delete not yet observed
              // remotely) — keep it; push re-asserts it.
            } else if (this.#remoteSupersedes(collName, id, remoteEnvelope, localEnvelope)) {
              await this.applyRemote(collName, id, remoteEnvelope)
              // Drop any now-superseded local dirty entry so a subsequent push doesn't
              // redundantly re-fight a CAS conflict over content pull just overwrote.
              this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
              pulled++
            }
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)))
          }
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)))
    }

    this.progress({ direction: 'pull', phase: 'records', records: pulled, bytes: this.pullBytes, total: { records: pulled } }, true)
    this.progressDone()
    this.pullBytes = 0
    this.recordOutcome('pull', errors)
    try {
      await this.persistMeta()
    } finally {
      this.pullByteSink = null // #807: stop attributing applies to this pull's KPI counters
      // #644 item 1: flush must run even if `persistMeta()` throws (see push()'s identical guard).
      await this.graphBatchController?.flush() // #638 Task 4
    }

    // core#74 — the callers counted a refused record before admission spoke.
    pulled = Math.max(0, pulled - this.#rejected.length)
    const applied = this.#applied, rejected = this.#rejected
    this.#applied = []; this.#rejected = []
    const result: PullResult = {
      pulled, conflicts, errors, erasures, ...(reserved > 0 && { reserved }), ...(phases !== null ? { phases } : {}),
      ...(applied.length > 0 && { applied }), ...(rejected.length > 0 && { rejected }),
      ...(crossed.epoch > 0 && { epoch: crossed.epoch }), ...(crossed.resynced && { resynced: true as const }),
    }
    this.emitter.emit('sync:pull', result)
    return result
  }

  /** Bidirectional sync: pull then push. */
  async sync(options?: { push?: PushOptions; pull?: PullOptions }): Promise<{ pull: PullResult; push: PushResult }> {
    const pullResult = await this.pull(options?.pull)
    const pushResult = await this.push(options?.push)
    return { pull: pullResult, push: pushResult }
  }

  /**
   * Push a specific subset of dirty entries (for sync transactions, ).
   * Entries are matched by collection+id from the dirty log; matched entries
   * are removed from the dirty log on success.
   */
  async pushFiltered(predicate: (entry: DirtyEntry) => boolean): Promise<PushResult> {
    await this.ensureLoaded()

    let pushed = 0
    const conflicts: Conflict[] = []
    const erasures: ErasureEnforcement[] = []
    const errors: Error[] = []
    const completed: number[] = []

    for (let i = 0; i < this.dirty.length; i++) {
      const entry = this.dirty[i]!
      if (!predicate(entry)) continue

      try {
        if (entry.action === 'delete') {
          await this.remote.delete(this.vault, entry.collection, entry.id)
          completed.push(i)
          pushed++
        } else {
          const envelope = await this.local.get(this.vault, entry.collection, entry.id)
          if (!envelope) {
            completed.push(i)
            continue
          }

          if (isTombstoneShape(envelope)) {
            // #590: a tombstone push is an erasure assertion — unconditional,
            // no CAS, no conflict resolution. Erasure always wins.
            await this.remote.put(this.vault, entry.collection, entry.id, envelope)
            completed.push(i)
            pushed++
            continue
          }

          try {
            await this.remote.put(
              this.vault,
              entry.collection,
              entry.id,
              envelope,
              entry.version - 1,
            )
            completed.push(i)
            pushed++
          } catch (err) {
            if (isConflictError(err)) {
              const remoteEnvelope = await this.remote.get(this.vault, entry.collection, entry.id)
              if (remoteEnvelope) {
                if (isTombstoneShape(remoteEnvelope)) {
                  // #590: remote already shredded this record — enforce locally,
                  // never resolve. Resolvers must not overrule an erasure.
                  await this.applyRemote(entry.collection, entry.id, remoteEnvelope)
                  erasures.push(this.reportErasure(entry.collection, entry.id, remoteEnvelope, envelope, 'push'))
                  completed.push(i)
                } else if (
                  remoteEnvelope._v === envelope._v &&
                  isDeleteMarker(remoteEnvelope) !== isDeleteMarker(envelope) &&
                  !this.conflictResolvers.get(entry.collection)
                ) {
                  // #589: a same-_v delete-vs-edit tie on the push channel. handleConflict's db-level
                  // 'version' default would resolve it to local-wins; the tie rule consults ONLY the
                  // per-collection resolver, else delete-wins. (When a per-collection resolver IS set,
                  // fall through to handleConflict, which already honors it — incl. the merged case.)
                  if (isDeleteMarker(remoteEnvelope)) {
                    // remote already deleted → converge locally, drop our (edit) push
                    await this.applyRemote(entry.collection, entry.id, remoteEnvelope)
                    completed.push(i)
                  } else {
                    // our local is the marker → force the delete onto the remote (unconditional put)
                    await this.remote.put(this.vault, entry.collection, entry.id, envelope)
                    completed.push(i)
                    pushed++
                  }
                } else {
                  const { handled, conflict } = await this.handleConflict(
                    entry.collection,
                    entry.id,
                    envelope,
                    remoteEnvelope,
                    'push',
                  )
                  conflicts.push(conflict)
                  if (handled === 'local') {
                    // #936: supersede, don't overwrite in place — see advancePastRemote.
                    const winner = await this.advancePastRemote(conflict.local, entry.collection, entry.id, remoteEnvelope)
                    await this.remote.put(this.vault, entry.collection, entry.id, winner)
                    if (winner !== conflict.local) await this.applyRemote(entry.collection, entry.id, winner, { admit: false })
                    completed.push(i)
                    pushed++
                  } else if (handled === 'remote') {
                    await this.applyRemote(entry.collection, entry.id, conflict.remote)
                    completed.push(i)
                  } else if (handled === 'merged' && conflict.local !== envelope) {
                    const merged = conflict.local
                    await this.remote.put(this.vault, entry.collection, entry.id, merged)
                    await this.applyRemote(entry.collection, entry.id, merged)
                    completed.push(i)
                    pushed++
                  }
                }
              }
            } else {
              throw err
            }
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }

    for (const i of completed.sort((a, b) => b - a)) {
      this.dirty.splice(i, 1)
    }

    this.recordOutcome('push', errors)
    await this.persistMeta()

    const result: PushResult = { pushed, conflicts, errors, erasures }
    this.emitter.emit('sync:push', result)
    return result
  }

  /**
   * #1036 — close out a push/pull. `push()` and `pull()` collect per-record
   * failures into their result's `errors` rather than throwing, and the clock used
   * to be stamped regardless — so an unreachable store still reported a fresh
   * `lastPush`, and a UI rendered "Last synced: just now" over a sync that moved
   * nothing. An attempt only advances the clock when it had no errors.
   *
   * An empty dirty log is a success, not a failure: nothing to send is not the
   * same as failing to send, and treating it otherwise would leave a quiet vault
   * looking permanently unsynced.
   */
  private recordOutcome(op: 'push' | 'pull', errors: readonly Error[]): void {
    const at = new Date().toISOString()
    if (errors.length > 0) {
      this.lastError = { at, op, message: errors[0]!.message }
      return
    }
    this.lastError = null
    if (op === 'push') this.lastPush = at
    else this.lastPull = at
  }

  /** Get current sync status. */
  /**
   * core#82 — re-align a CORRUPTED local from the target. An ordinary pull
   * cannot repair a damaged local envelope: it keeps its `_v`, so it wins
   * (or ties) against the target's healthy copy. Here every local
   * user-collection envelope is verified with the same `MergeAuthority`
   * check pull runs on remote envelopes; one that fails is replaced by the
   * target's copy when THAT verifies, and the dirty log is dropped (a dirty
   * entry over a damaged record would push the damage). Records at a tier
   * the caller holds no key for pass unverified, as in pull — this repairs
   * what the caller can read. Requires a `MergeAuthority` (a vault-attached
   * engine on an encrypted vault).
   */
  /**
   * core#96 (pilot-1, finding B) — bring one member's keyring file down from
   * this target if the target's copy supersedes ours. Called by the kernel
   * before an authority edit; reloads the caller's own keyring in place when
   * it is the one refreshed (core#82).
   */
  async refreshKeyring(userId: string): Promise<boolean> {
    await this.ensureLoaded()
    const copied = await pullKeyringFile(this.remote, this.local, this.vault, userId)
    if (copied && this.rosterReload && userId === this.rosterReload.userId) await this.rosterReload.reload()
    return copied
  }

  async realign(): Promise<RealignResult> {
    await this.ensureLoaded()
    if (!this.mergeAuthority) throw new ValidationError('realign: requires a vault-attached engine on an encrypted vault (no MergeAuthority).')
    const errors: Error[] = []
    let checked = 0
    let replaced = 0
    let unrecoverable = 0
    const local = await this.local.loadAll(this.vault)
    for (const [collection, records] of Object.entries(local)) {
      for (const [id, envelope] of Object.entries(records)) {
        checked++
        if (isTombstoneShape(envelope) || isDeleteMarker(envelope)) continue
        if (await this.mergeAuthority.verify(collection, id, envelope)) continue
        const remote = await this.remote.get(this.vault, collection, id)
        if (remote && (await this.mergeAuthority.verify(collection, id, remote))) {
          await this.local.put(this.vault, collection, id, remote)
          await this.cacheInvalidator?.(collection, id, 'put')
          replaced++
        } else {
          unrecoverable++
          errors.push(new ValidationError(`realign: "${collection}/${id}" fails to authenticate locally and the target holds no healthy copy.`))
        }
      }
    }
    this.dirty = []
    await this.persistMeta()
    return { checked, replaced, unrecoverable, errors }
  }

  status(): SyncStatus {
    // #809 — readiness rides the status surface that already exists rather than
    // a second accessor, so an app asks one question to learn everything about
    // this vault's sync. Absent entirely unless a phased policy is running.
    const scheduled = this.scheduler?.status
    return {
      dirty: this.dirty.length,
      lastPush: this.lastPush,
      lastPull: this.lastPull,
      ...(this.epoch !== null ? { epoch: this.epoch } : {}), // core#72
      ...(this.inFlight ? { inFlight: this.inFlight } : {}),
      online: this.isOnline,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(scheduled && scheduled.readiness.size > 0
        ? { readiness: scheduled.readiness, phase: scheduled.phase }
        : {}),
    }
  }

  // ─── Auto-Sync ───────────────────────────────────────────────────

  /** Start auto-sync: listen for online/offline events, optional periodic sync. */
  startAutoSync(intervalMs?: number): void {
    // Online/offline detection
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('online', this.handleOnline)
      globalThis.addEventListener('offline', this.handleOffline)
    }

    // Periodic sync
    if (intervalMs && intervalMs > 0) {
      this.autoSyncInterval = setInterval(() => {
        if (this.isOnline) {
          void this.sync()
        }
      }, intervalMs)
    }
  }

  /** Stop auto-sync and scheduler. */
  stopAutoSync(): void {
    this.stopScheduler()
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', this.handleOnline)
      globalThis.removeEventListener('offline', this.handleOffline)
    }
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval)
      this.autoSyncInterval = null
    }
  }

  private handleOnline = (): void => {
    this.isOnline = true
    this.emitter.emit('sync:online', undefined as never)
    void this.sync()
  }

  private handleOffline = (): void => {
    this.isOnline = false
    this.emitter.emit('sync:offline', undefined as never)
  }

  /** Apply an envelope to the local store and refresh in-memory views (#598). `action` (#640):
   *  classified HERE — the one choke point that still holds the envelope — so the
   *  cacheInvalidator seam (and, downstream, the dispatch wave) can tell a pulled delete from an
   *  ordinary put. `isTombstoneShape` covers a forgotten-elsewhere record arriving as a shred;
   *  `isDeleteMarker` covers an ordinary (#589) delete — both route to the SAME 'delete' action
   *  (sync delete ≠ forget: freshness only, no shred/residue channel on the receiving side). */
  /**
   * #936 — a local-wins resolution write must SUPERSEDE the remote, never
   * overwrite it in place: when the winner's `_v` does not already exceed
   * the remote's (the same-`_v` push tie), re-stamp it at `remote._v + 1`.
   * Without this the loser's next pull sees no delta (`_v`-based
   * detection) and the peers stay silently diverged at the same version.
   * ## Why this is async, and why it goes through `MergeAuthority` (#1093)
   *
   * It used to be `{ ...winner, _v: remote._v + 1 }` — a metadata restamp on
   * ciphertext the engine cannot decrypt. That spread was the SOLE reason `_v`
   * could not be bound into the AAD: a version rewritten onto a body sealed at
   * a different one produces a record no reader can open.
   *
   * `with-sync` is DEK-free by design and `check:architecture` enforces it, so
   * the re-seal cannot happen here. It happens in the injected authority, which
   * holds the keys. The engine still decides WHICH version to advance to; it
   * simply no longer pretends it can rewrite a sealed body.
   *
   * The authority is ALWAYS present in the product — `kernel/noydb.ts` builds
   * one from the keyring and passes it at both engine-construction sites, and
   * `with-sync/active.ts` is the only place an engine is constructed. The
   * fallback below is reachable only by constructing `SyncEngine` directly,
   * which tests do. It restamps, as before — and would produce an unreadable
   * record if such a test ever held AEAD-sealed envelopes. None do; the
   * fixtures that reach it build their own plaintext ones.
   *
   * The 'merged' branch needs none of this: resolver output is already stamped
   * `max(local, remote) + 1` by whoever built it.
   */
  private async advancePastRemote(winner: EncryptedEnvelope, collection: string, id: string, remote: EncryptedEnvelope): Promise<EncryptedEnvelope> {
    if (winner._v > remote._v) return winner
    const toVersion = remote._v + 1
    if (!this.mergeAuthority) return { ...winner, _v: toVersion }
    return this.mergeAuthority.advance(collection, id, winner, toVersion)
  }

  /**
   * core#100 — does the remote copy supersede ours? A higher `_v`, as always;
   * or the SAME `_v` with different bytes while we hold no pending write for
   * it: a DEK rotation re-encrypts records in place, and a replica that kept
   * the old ciphertext would read `TamperedError` under the delivered key.
   * `applyRemote` still authenticates it (`MergeAuthority`) before it lands.
   */
  #remoteSupersedes(collection: string, id: string, remote: EncryptedEnvelope, local: EncryptedEnvelope): boolean {
    if (remote._v > local._v) return true
    if (remote._v !== local._v) return false
    if (this.dirty.some(d => d.collection === collection && d.id === id)) return false
    return envelopeBodyForHash(remote) !== envelopeBodyForHash(local)
  }

  private async applyRemote(collection: string, id: string, envelope: EncryptedEnvelope, opts?: { readonly admit?: boolean }): Promise<void> {
    // #1042 — FAIL CLOSED, and do it HERE rather than at the 14 call sites.
    // Every path that commits store-supplied ciphertext goes through this
    // function, so gating it once covers them all by construction instead of by
    // remembering. A gate added per-caller is a gate someone forgets.
    //
    // Throwing is the correct shape, not a shortcut: each pull entry is wrapped
    // in its own try/catch that records the error and moves on, so a poisoned
    // record becomes one `PullResult.errors` entry rather than a halted sync —
    // which is exactly what a hostile store would want.
    //
    // Ordering is the whole point: this runs BEFORE `local.put`, so a rejection
    // costs the client nothing. Its existing copy is untouched.
    if (this.mergeAuthority && !(await this.mergeAuthority.verify(collection, id, envelope))) {
      throw new ValidationError(
        `sync: refusing remote envelope for "${collection}/${id}" — it does not authenticate at the ` +
        'identity and version it claims. The local copy is unchanged.',
      )
    }
    // core#74 — ADMISSION. The vault runs its gates and hooks on the decrypted
    // incoming record against this device's state. Erasures are never gated.
    // A refusal is a fate, not an error: parked with the envelope intact, the
    // local copy untouched, reported and emitted. `pulled` is corrected at the
    // end of the run (the callers count before they know).
    // `admit: false` (pilot-1 on #74): this device's OWN record, re-versioned past
    // the remote after a conflict it won — it passed the writer's gate when it
    // was written; judging it again as `sync-apply` is wrong and confusing.
    const isErasure = isTombstoneShape(envelope) || isDeleteMarker(envelope)
    if (this.admission && !isErasure && opts?.admit !== false) {
      const verdict = await this.admission.admit(collection, id, envelope)
      if (!verdict.admitted) {
        const rejection: SyncRejection = {
          vault: this.vault, collection, id, reason: verdict.reason, version: envelope._v,
          ...(envelope._by !== undefined ? { by: envelope._by } : {}), at: new Date().toISOString(),
        }
        const parked: ParkedRejection = { rejection, envelope }
        await this.local.put(
          this.vault, REJECTED_COLLECTION, `${collection}::${id}`,
          buildRecordEnvelope({ collection: REJECTED_COLLECTION, id: `${collection}::${id}`, version: 1 }, { iv: '', data: JSON.stringify(parked) }),
        )
        this.#rejected.push(rejection)
        this.emitter.emit('sync:rejected', rejection)
        return
      }
    }
    const prior = await this.local.get(this.vault, collection, id)
    await this.local.put(this.vault, collection, id, envelope)
    this.#applied.push({
      collection, id, action: isErasure ? 'delete' : 'put',
      ...(prior && prior._v < envelope._v ? { replaced: { version: prior._v, ...(prior._by !== undefined ? { by: prior._by } : {}) } } : {}),
    })
    this.pullBytes += envelopeBodySize(envelope) // core#81
    if (this.pullByteSink !== null) {
      // #807: KPI — one applied envelope; bytes ≈ ciphertext payload size.
      this.pullByteSink.records++
      this.pullByteSink.bytes += envelopeBodySize(envelope)
    }
    const action: 'put' | 'delete' = isTombstoneShape(envelope) || isDeleteMarker(envelope) ? 'delete' : 'put'
    await this.cacheInvalidator?.(collection, id, action)
  }

  /** Record + emit a tombstone enforcement (#590). */
  private reportErasure(
    collection: string, id: string,
    tombstone: EncryptedEnvelope, suppressed: EncryptedEnvelope,
    direction: 'pull' | 'push',
  ): ErasureEnforcement {
    const enforcement: ErasureEnforcement = { vault: this.vault, collection, id, tombstone, suppressed, direction }
    this.emitter.emit('sync:erasure', enforcement)
    return enforcement
  }

  /**
   * Re-assert a local tombstone over a live remote envelope (#590): the shred
   * wins in both directions, regardless of `_v`. Bumps the tombstone to the
   * suppressed envelope's `_v` when higher so per-key version counters stay
   * monotonic on every store; `_by` (the shredding actor) is preserved.
   */
  private async reassertTombstone(
    collection: string, id: string,
    tombstone: EncryptedEnvelope, suppressedRemote: EncryptedEnvelope,
  ): Promise<ErasureEnforcement> {
    let winner = tombstone
    if (suppressedRemote._v > tombstone._v) {
      winner = { ...tombstone, _v: suppressedRemote._v, _ts: new Date().toISOString() }
      await this.applyRemote(collection, id, winner)
    }
    await this.remote.put(this.vault, collection, id, winner)
    // The re-assert already delivered the tombstone remotely — drop any dirty
    // entry so the following push doesn't redundantly re-put it.
    this.dirty = this.dirty.filter(d => !(d.collection === collection && d.id === id))
    return this.reportErasure(collection, id, winner, suppressedRemote, 'pull')
  }

  /**
   * Resolve a conflict, checking per-collection resolvers first,
   * then falling back to the db-level `ConflictStrategy`.
   *
   * Returns the resolved `Conflict` object (possibly with `resolve` set for
   * manual mode) and a `handled` discriminant:
   * - `'local'` — keep the local envelope; push it to remote.
   * - `'remote'` — keep the remote envelope; update local.
   * - `'merged'` — a custom merge fn produced a new envelope stored as `conflict.local`.
   * - `'deferred'` — manual mode, resolve was not called synchronously.
   */
  private async handleConflict(
    collection: string,
    id: string,
    local: EncryptedEnvelope,
    remote: EncryptedEnvelope,
    _phase: 'push' | 'pull',
  ): Promise<{ handled: 'local' | 'remote' | 'merged' | 'deferred'; conflict: Conflict }> {
    const resolver = this.conflictResolvers.get(collection)

    if (resolver) {
      // Per-collection resolver is responsible for emitting sync:conflict
      // (manual policy emits with a resolve callback; LWW/FWW/custom are silent).
      const winner = await resolver(id, local, remote)
      const base: Conflict = {
        vault: this.vault,
        collection,
        id,
        local,
        remote,
        localVersion: local._v,
        remoteVersion: remote._v,
      }
      if (winner === null) return { handled: 'deferred', conflict: base }
      if (winner === local) return { handled: 'local', conflict: base }
      if (winner === remote) return { handled: 'remote', conflict: base }
      // Custom merge fn produced a new envelope — store as conflict.local for the caller
      return {
        handled: 'merged',
        conflict: { ...base, local: winner, localVersion: winner._v },
      }
    }

    // Fall back to db-level strategy — emit once
    const baseConflict: Conflict = {
      vault: this.vault,
      collection,
      id,
      local,
      remote,
      localVersion: local._v,
      remoteVersion: remote._v,
    }
    this.emitter.emit('sync:conflict', baseConflict)
    const side = this.legacyResolve(baseConflict)
    return { handled: side, conflict: baseConflict }
  }

  /** DB-level ConflictStrategy resolution (legacy, kept for backward compat). */
  private legacyResolve(conflict: Conflict): 'local' | 'remote' {
    if (typeof this.strategy === 'function') {
      return this.strategy(conflict)
    }
    switch (this.strategy) {
      case 'local-wins': return 'local'
      case 'remote-wins': return 'remote'
      case 'version':
      default:
        return conflict.localVersion >= conflict.remoteVersion ? 'local' : 'remote'
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    const envelope = await this.local.get(this.vault, '_sync', 'meta')
    if (envelope) {
      const meta = JSON.parse(envelope._data ?? '') as SyncMetadata
      this.dirty = [...meta.dirty]
      this.lastPush = meta.last_push
      this.lastPull = meta.last_pull
      this.epoch = meta.epoch ?? null
    }

    this.loaded = true
  }

  private async persistMeta(): Promise<void> {
    const meta: SyncMetadata = {
      _noydb_sync: NOYDB_SYNC_VERSION,
      last_push: this.lastPush,
      last_pull: this.lastPull,
      dirty: this.dirty,
      ...(this.epoch !== null ? { epoch: this.epoch } : {}),
    }

    const envelope: EncryptedEnvelope = buildRecordEnvelope(
      { collection: '_sync', id: 'meta', version: 1 },
      { iv: '', data: JSON.stringify(meta) },
    )

    await this.local.put(this.vault, '_sync', 'meta', envelope)
  }
}
