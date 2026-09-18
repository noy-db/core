/**
 * `@noy-db/hub/to`, bound ALONE — a store author's whole import list (#54).
 *
 * ⛔ One import line, and it must stay one. A satellite binds its port and
 * nothing else; the moment this file needs a second entry, `/to` has stopped
 * being bindable alone and the point of the subpath is gone. The test parses
 * this file's imports and fails on a second specifier, because the tempting
 * repair for a red fixture is to add the root barrel.
 */
import {
  ConflictError,
  isConflictError,
  createStoreLocator,
  isPodStore,
  NOYDB_ENVELOPE_GENERATION,
  type NoydbStore,
  type EncryptedEnvelope,
  type VaultSnapshot,
  type StoreCapabilities,
  type StoreDescriptor,
} from '@noy-db/hub/to'

/** The 6-method contract, implemented the way a `to-*` package implements it. */
class MemoryishStore implements NoydbStore {
  readonly name = 'bindable-alone-fixture'
  // ⚠️ MEASURED GAP, left in place deliberately: `auth` is REQUIRED on
  // `StoreCapabilities`, its type `StoreAuth` (and `StoreAuthKind`) is on the
  // ROOT BARREL only, and `/to` does not re-export either. A store author
  // binding `/to` alone can still write the literal — structural typing — but
  // cannot NAME the type: no annotated helper, no re-export, no `satisfies`.
  // Reported rather than patched here; a subpath addition is the root's call.
  readonly capabilities: StoreCapabilities = {
    casAtomic: true,
    auth: { kind: 'none', required: false, flow: 'static' },
  }
  readonly #rows = new Map<string, EncryptedEnvelope>()

  #key(vault: string, collection: string, id: string): string {
    return `${vault}/${collection}/${id}`
  }

  async get(vault: string, collection: string, id: string): Promise<EncryptedEnvelope | null> {
    return this.#rows.get(this.#key(vault, collection, id)) ?? null
  }

  async put(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void> {
    const key = this.#key(vault, collection, id)
    const current = this.#rows.get(key)
    if (expectedVersion !== undefined && current?._v !== expectedVersion) {
      // The reason a store author needs the CLASS, not just the predicate.
      throw new ConflictError(current?._v ?? 0, `${collection}/${id}: version conflict`)
    }
    this.#rows.set(key, envelope)
  }

  async delete(vault: string, collection: string, id: string): Promise<void> {
    this.#rows.delete(this.#key(vault, collection, id))
  }

  async list(vault: string, collection: string): Promise<string[]> {
    const prefix = `${vault}/${collection}/`
    return [...this.#rows.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
  }

  async loadAll(): Promise<VaultSnapshot> {
    return {}
  }

  async saveAll(): Promise<void> {}
}

/**
 * And the caller half a store author actually writes: register the store,
 * classify what came back, and recognise a conflict raised by a DIFFERENT
 * copy of this subpath — which is why `isConflictError` had to be exported
 * here and not only from the root barrel (#1224).
 */
export async function exercise(): Promise<readonly [boolean, boolean, number]> {
  const locator = createStoreLocator()
  locator.register('memoryish', () => new MemoryishStore())
  const descriptor: StoreDescriptor = { kind: 'memoryish', class: 'local', address: { dir: '/tmp' } }
  const store = await locator.resolve(descriptor)

  let sawConflict = false
  try {
    const envelope: EncryptedEnvelope = { _noydb: 1, _v: 7, _ts: new Date().toISOString() }
    await store.put('v', 'c', 'id', envelope, 3)
  } catch (err) {
    sawConflict = isConflictError(err)
  }

  return [sawConflict, isPodStore(store), NOYDB_ENVELOPE_GENERATION] as const
}
