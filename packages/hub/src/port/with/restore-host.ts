/**
 * core#76 — the capability `restoreTo(T)` borrows from the vault.
 *
 * Same shape and same reason as `AdmissionAuthority`: the kernel spine may not
 * statically import a `with-*` module (`port-layering`, the S4 gate), and the
 * restore engine must not reach into `Vault`. So the contract lives here and
 * both sides bind it — the vault supplies closures, the engine consumes them.
 *
 * ⚠️ `import type` does NOT exempt a static import from that rule, and it is
 * an easy one to talk yourself past: the emitted JS carries no import, so it
 * feels free. The guard is about the DEPENDENCY DIRECTION the source declares,
 * not about what survives compilation — this interface was in the engine
 * module and caught on exactly that.
 */
import type { NoydbStore } from '../../kernel/types.js'

export interface RestoreToHost {
  readonly adapter: NoydbStore
  readonly vault: string
  /** `vault.at(T).collection(name)` — ids and records as they were at T. */
  instantCollection(name: string): { list(): Promise<string[]>; get(id: string): Promise<unknown> }
  /** The live collection, written through so guards/periods/history/ledger all fire. */
  liveCollection(name: string): {
    get(id: string): Promise<unknown>
    put(id: string, record: unknown): Promise<unknown>
    delete(id: string): Promise<unknown>
    list(): Promise<unknown[]>
  }
  /** Live DATA collection names (no `_` prefixes). */
  liveCollectionNames(): Promise<string[]>
}
