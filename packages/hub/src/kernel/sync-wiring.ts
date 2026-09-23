/**
 * The vault-side seams every sync engine of a vault is wired with — at
 * `openVault()` and again on `attachSyncTarget()` (core#90). One function so
 * the two paths cannot drift: `sync` used to be construction-only, which forced
 * pilot-1's direct cloud shape (a target whose credentials come from
 * `vault.broker()`, reachable only once the vault is open) into a two-phase
 * open with a reconstruct in between. Attaching after open needs exactly the
 * wiring open does, plus a replay of the conflict resolvers collections
 * registered before the target existed — hence `conflictResolvers` on the host.
 *
 * @internal
 */
import type { Vault } from './vault.js'
import type { CollectionConflictResolver, EncryptedEnvelope, SyncRejection } from './types.js'

// Structural on purpose: the kernel spine may not import a with-* module
// statically (port-layering), so the engine and the keyring are named by the
// slice this function touches, not by their classes.
type WiredEngine = {
  setCacheInvalidator(fn: (collection: string, id: string, action: 'put' | 'delete') => Promise<void>): void
  setGraphBatchController(c: { begin(): void; flush(): Promise<void> }): void
  setReservedLookupSource(s: { collections(): readonly string[] }): void
  setReservedDictExpander(fn: (names: readonly string[]) => readonly string[]): void
  setPeriodPullSource(s: { periods(): Promise<readonly unknown[]> }): void
  setRosterReload(seam: { userId: string; reload: () => Promise<void> }): void
  // ⚠️ A STRUCTURAL TWIN of `AdmissionAuthority` (port/with/admission-authority.ts), because the
  // kernel spine may not import a with-* module. The two have no type-level link, so widening one
  // and not the other fails ONLY in the declarations build — `tsc --noEmit` on the app program
  // stays green. core#108 widened both; change them together.
  setAdmission(a: { admit(collection: string, id: string, envelope: EncryptedEnvelope, origin?: 'sync-apply' | 'push-recheck'): Promise<{ admitted: true } | { admitted: false; reason: string }> }): void
  // core#107 — the twin of `RejectionCourier`, for the same reason as above.
  setRejectionCourier(c: {
    seal(collection: string, id: string, rejection: SyncRejection, version: number): Promise<EncryptedEnvelope | null>
    open(collection: string, id: string, envelope: EncryptedEnvelope): Promise<SyncRejection | null>
  }): void
  setCollectionNames(fn: () => readonly string[]): void
  registerConflictResolver(name: string, resolver: CollectionConflictResolver): void
}

export interface EngineWiringHost {
  readonly user: string
  readonly keyringCache: ReadonlyMap<string, { readonly deks: ReadonlyMap<string, unknown> }>
  readonly conflictResolvers: ReadonlyMap<string, ReadonlyMap<string, CollectionConflictResolver>>
}

export function wireEngine(host: EngineWiringHost, name: string, comp: Vault, engine: WiredEngine): void {
  engine.setCacheInvalidator((collection, id, action) => comp._invalidateSyncApplied(collection, id, action))
  engine.setGraphBatchController({ begin: () => comp._beginGraphBatch(), flush: () => comp._flushGraphBatch() })
  engine.setReservedLookupSource({ collections: () => comp._reservedLookupCollectionNames() }) // #650 Task 4
  engine.setReservedDictExpander(names => comp._reservedDictDepsOf(names)) // #653
  engine.setPeriodPullSource({ periods: () => comp.listPeriods() }) // #807 period-scoped pull windows
  engine.setRosterReload({ userId: host.user, reload: () => comp._reloadKeyringAfterSync() }) // core#82
  // core#74; core#108 — `origin` MUST be forwarded: a closure that drops it compiles,
  // and every push-recheck then judges the record as an arriving one.
  engine.setAdmission({ admit: (collection, id, envelope, origin) => comp._admitRemote(collection, id, envelope, origin) })
  engine.setRejectionCourier({ // core#107
    seal: (collection, id, rejection, version) => comp._sealRejection(collection, id, rejection, version),
    open: (collection, id, envelope) => comp._openRejection(collection, id, envelope),
  })
  engine.setCollectionNames(() => [...(host.keyringCache.get(name)?.deks.keys() ?? [])].filter(n => !n.startsWith('_'))) // core#81 paged pull
  for (const [resolverName, resolver] of host.conflictResolvers.get(name) ?? []) engine.registerConflictResolver(resolverName, resolver)
}
