/**
 * **@noy-db/to-browser-idb** — IndexedDB-backed NOYDB store.
 *
 * The recommended browser store. Uses a single IndexedDB database
 * (`{prefix}_noydb`) with one object store (`records`). Composite string
 * keys (`{vault}:{collection}:{id}`) avoid the need for complex indexes.
 *
 * ## Why IndexedDB over localStorage
 *
 * - **Larger quota** — typically 50–80% of available disk vs. localStorage's
 *   5 MB hard cap.
 * - **True atomic CAS** — the compare-and-swap check and write happen inside
 *   a single `readwrite` IDB transaction, so concurrent writes from two tabs
 *   cannot interleave. (`casAtomic: true`.)
 * - **Async API** — doesn't block the main thread during large reads.
 *
 * ## Obfuscation mode
 *
 * Identical to `@noy-db/to-browser-local` — FNV-1a hashed keys + XOR-encoded
 * metadata. Envelope `_data` is always AES-GCM ciphertext regardless of this
 * setting.
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `true` — single readwrite IDB transaction per put |
 * | `listPage` | ✓ — cursor-based pagination via `getAllKeys()` |
 * | `ping` | ✓ — `openDB()` round-trip |
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

/**
 * Options for `toBrowserIdb()`.
 *
 * All NOYDB data is stored in a single IndexedDB database named
 * `{prefix}_noydb`, using composite string keys of the form
 * `{vault}:{collection}:{id}`. CAS checks and writes happen inside a
 * single `readwrite` IDB transaction, giving true atomic compare-and-swap
 * (`casAtomic: true`). Enable `obfuscate` to hash key components and
 * XOR-encode metadata — same obfuscation model as `toBrowserLocal`.
 */
export interface BrowserIdbOptions {
  /** Storage key prefix. Default: 'noydb'. */
  prefix?: string
  /** Obfuscate storage keys so collection/record names are not readable. Default: false. */
  obfuscate?: boolean
}

/**
 * Create an IndexedDB-backed store adapter.
 *
 * Key scheme (normal):    `{vault}:{collection}:{id}`
 * Key scheme (obfuscated): `{hash}:{hash}:{hash}`
 *
 * StoreCapabilities:
 *   casAtomic: true  — CAS check + write happen inside a single readwrite IDB transaction
 *   auth: { kind: 'browser-origin', flow: 'implicit', required: false }
 */
export function toBrowserIdb(options: BrowserIdbOptions = {}): NoydbStore {
  const prefix = options.prefix ?? 'noydb'
  const obfuscate = options.obfuscate ?? false
  const obfKey = obfuscate ? makeObfKey(prefix) : ''

  return createIndexedDBAdapter(prefix, obfuscate, obfKey)
}

// ─── Key Obfuscation ───────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash → 8-char hex string.
 * Not cryptographic — just makes keys opaque to casual inspection.
 */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function hashComponent(value: string, obfuscate: boolean): string {
  return obfuscate ? fnv1a(value) : value
}

// ─── XOR Encode/Decode (makes metadata unreadable in storage) ──────────

/** XOR-encode a string with a repeating key, return base64. */
function xorEncode(plaintext: string, key: string): string {
  const bytes = new TextEncoder().encode(plaintext)
  const keyBytes = new TextEncoder().encode(key)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = bytes[i]! ^ keyBytes[i % keyBytes.length]!
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/** Decode a base64 XOR-encoded string. */
function xorDecode(encoded: string, key: string): string {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  const keyBytes = new TextEncoder().encode(key)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) ^ keyBytes[i % keyBytes.length]!
  }
  return new TextDecoder().decode(bytes)
}

/** Stored value wraps envelope + encoded original key parts. */
interface StoredValue {
  /** Encoded original record ID. */
  _oi: string
  /** Encoded original collection name. */
  _oc: string
  /** The encrypted envelope. */
  _e: EncryptedEnvelope
}

function makeObfKey(prefix: string): string {
  return prefix + ':noydb-obf-key'
}

// ─── IndexedDB Backend ─────────────────────────────────────────────────

function createIndexedDBAdapter(prefix: string, obfuscate: boolean, obfKey: string): NoydbStore {
  const DB_NAME = `${prefix}_noydb`
  const STORE_NAME = 'records'
  let dbPromise: Promise<IDBDatabase> | null = null

  /**
   * Open (or reuse) the connection.
   *
   * ⛔ THE CACHE IS INVALIDATED NOW, AND IT WAS NOT (family#165). `dbPromise`
   * held a connection for the lifetime of the adapter, so once that connection
   * went away every later transaction failed against a dead handle — forever,
   * because nothing cleared the cache. A connection goes away for ordinary
   * reasons: another tab runs a `versionchange`, the browser evicts the origin's
   * storage under pressure, or the user clears site data. The adapter did not
   * recover from any of them; it needed a page reload.
   *
   * ⚠️ A REJECTED open was cached too, which is the worse half: one transient
   * failure at startup — storage not yet granted, a private-mode quirk — and
   * every call for the rest of the session replayed that same rejection. The
   * `catch` below clears it so the next call retries.
   *
   * ⚠️ `onversionchange` CLOSES deliberately. Another tab upgrading the schema
   * is blocked until every other connection closes, so holding one open hangs
   * the other tab rather than protecting this one. Closing and reopening on
   * demand is what lets both make progress.
   */
  function openDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }
        request.onsuccess = () => {
          const db = request.result
          // Any of these means the handle is no longer usable. Drop it so the
          // next call reopens instead of failing against a dead connection.
          const invalidate = (): void => { if (dbPromise !== null) dbPromise = null }
          db.onclose = invalidate
          db.onversionchange = () => { db.close(); invalidate() }
          resolve(db)
        }
        request.onerror = () => reject(request.error)
      })
      // A cached REJECTION would make one transient failure permanent.
      dbPromise.catch(() => { dbPromise = null })
    }
    return dbPromise
  }

  function key(vault: string, collection: string, id: string): string {
    return `${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:${hashComponent(id, obfuscate)}`
  }

  /**
   * Open a transaction and hand back its store plus a `complete` promise.
   *
   * ⛔ `complete` CAN NEVER BE UNHANDLED (family#165). It rejects on
   * `transaction.onerror`, and every read path here used to destructure only
   * `{ store }` — so a transaction that failed rejected a promise nobody was
   * listening to. That is an `unhandledrejection` event in a browser and a
   * process-level warning (or exit, under `--unhandled-rejections=strict`) in
   * Node: a store-level read error taking down the host application, from a
   * path the caller was already awaiting an error from.
   *
   * ⚠️ The `catch` below marks the ORIGINAL promise handled without consuming
   * it — `p.catch()` returns a new promise and leaves `p` rejecting for anyone
   * who awaits it. So a caller that awaits `complete` still sees the real
   * error; a caller that does not no longer crashes the host. Both halves
   * matter, and swallowing with `.then(() => {})` on the returned value would
   * have kept only the second.
   */
  function tx(mode: IDBTransactionMode): Promise<{ store: IDBObjectStore; complete: Promise<void> }> {
    return openDB().then(db => {
      const transaction = db.transaction(STORE_NAME, mode)
      const store = transaction.objectStore(STORE_NAME)
      const complete = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
      complete.catch(() => {}) // see above — handled, not consumed
      return { store, complete }
    })
  }

  function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  return {
    name: 'browser:indexedDB',

    capabilities: {
      casAtomic: true,
      auth: { kind: 'browser-origin' as const, required: false, flow: 'implicit' as const },
    },

    async get(vault, collection, id) {
      // family#165 — `complete` is awaited on the read paths too, so a
      // transaction error REACHES the caller instead of rejecting into nothing.
      const { store, complete } = await tx('readonly')
      const raw = await idbRequest(store.get(key(vault, collection, id)))
      await complete
      if (!raw) return null
      if (obfuscate && typeof raw === 'object' && '_e' in (raw as StoredValue)) {
        return (raw as StoredValue)._e
      }
      return raw as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const k = key(vault, collection, id)

      const { store, complete } = await tx('readwrite')
      if (expectedVersion !== undefined) {
        // family#147 — an absent record is at version 0, so the comparison runs even
        // when nothing is stored: `0 === 0` creates (core#134), while a nonzero
        // expectation against nothing conflicts instead of upserting. The `if
        // (existing)` guard used to skip the check entirely in that case.
        const existing = await idbRequest(store.get(k))
        const current = existing
          ? (obfuscate && '_e' in (existing as StoredValue) ? (existing as StoredValue)._e : existing as EncryptedEnvelope)._v
          : 0
        if (current !== expectedVersion) {
          throw new ConflictError(current, `Version conflict: expected ${expectedVersion}, found ${current}`)
        }
      }

      const value = obfuscate ? { _oi: xorEncode(id, obfKey), _oc: xorEncode(collection, obfKey), _e: envelope } : envelope
      store.put(value, k)
      await complete
    },

    async delete(vault, collection, id) {
      const { store, complete } = await tx('readwrite')
      store.delete(key(vault, collection, id))
      await complete
    },

    async list(vault, collection) {
      const pfx = `${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:`
      const { store, complete } = await tx('readonly')
      const allKeys = await idbRequest(store.getAllKeys()) as string[]

      if (!obfuscate) {
        const ids = allKeys
          .filter(k => typeof k === 'string' && k.startsWith(pfx))
          .map(k => k.slice(pfx.length))
        await complete // family#165
        return ids
      }

      // Obfuscated: need to read values for original IDs
      const ids: string[] = []
      for (const k of allKeys) {
        if (typeof k !== 'string' || !k.startsWith(pfx)) continue
        const raw = await idbRequest(store.get(k))
        if (raw && typeof raw === 'object' && '_oi' in (raw as StoredValue)) {
          ids.push(xorDecode((raw as StoredValue)._oi, obfKey))
        }
      }
      await complete // family#165
      return ids
    },

    async loadAll(vault) {
      const pfx = `${hashComponent(vault, obfuscate)}:`
      const { store, complete } = await tx('readonly')
      const allKeys = await idbRequest(store.getAllKeys()) as string[]
      const snapshot: VaultSnapshot = {}

      for (const k of allKeys) {
        if (typeof k !== 'string' || !k.startsWith(pfx)) continue

        const raw = await idbRequest(store.get(k))
        if (!raw) continue

        let collection: string
        let id: string
        let envelope: EncryptedEnvelope

        if (obfuscate && typeof raw === 'object' && '_e' in (raw as StoredValue)) {
          const stored = raw as StoredValue
          collection = xorDecode(stored._oc, obfKey)
          id = xorDecode(stored._oi, obfKey)
          envelope = stored._e
        } else {
          const rest = k.slice(pfx.length)
          const colonIdx = rest.indexOf(':')
          if (colonIdx < 0) continue
          collection = rest.slice(0, colonIdx)
          id = rest.slice(colonIdx + 1)
          envelope = raw as EncryptedEnvelope
        }

        if (collection.startsWith('_')) continue
        if (!snapshot[collection]) snapshot[collection] = {}
        snapshot[collection]![id] = envelope
      }

      await complete // family#165
      return snapshot
    },

    async saveAll(vault, data) {
      const { store, complete } = await tx('readwrite')

      // family#147 — `saveAll` REPLACES, so every non-underscore record in this
      // vault goes first and the snapshot is written over the top; an empty record
      // set therefore empties its collection. Underscore collections are left
      // standing (a partial snapshot must not strand `_keyring`) but are overwritten
      // when the snapshot carries them.
      // ⛔ The deletes share the SAME readwrite transaction as the writes below, so a
      // reader never observes the vault mid-replace. Doing it in a second
      // transaction would open exactly that window.
      const pfx = `${hashComponent(vault, obfuscate)}:`
      for (const k of await idbRequest(store.getAllKeys()) as string[]) {
        if (typeof k !== 'string' || !k.startsWith(pfx)) continue
        let collection: string
        if (obfuscate) {
          const raw = await idbRequest(store.get(k))
          if (!raw || typeof raw !== 'object' || !('_oc' in (raw as StoredValue))) continue
          collection = xorDecode((raw as StoredValue)._oc, obfKey)
        } else {
          const colonIdx = k.slice(pfx.length).indexOf(':')
          if (colonIdx < 0) continue
          collection = k.slice(pfx.length, pfx.length + colonIdx)
        }
        if (collection.startsWith('_')) continue
        store.delete(k)
      }

      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          const value = obfuscate ? { _oi: xorEncode(id, obfKey), _oc: xorEncode(collection, obfKey), _e: envelope } : envelope
          store.put(value, key(vault, collection, id))
        }
      }
      await complete
    },

    async ping() {
      try {
        await openDB()
        return true
      } catch {
        return false
      }
    },

    /**
     * Paginate over a collection backed by IndexedDB.
     *
     * Strategy: read every key in the prefix once (sorted), then slice
     * by cursor offset. IndexedDB's `getAllKeys()` returns sorted keys
     * efficiently for the modern browsers we target (Chrome 87+,
     * Firefox 78+, Safari 14+, Edge 88+ — same baseline as the rest of
     * the build target).
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const pfx = `${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:`
      const { store, complete } = await tx('readonly')
      const allKeys = await idbRequest(store.getAllKeys()) as string[]
      const matchedKeys = allKeys
        .filter(k => typeof k === 'string' && k.startsWith(pfx))
        .sort()

      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, matchedKeys.length)

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const k = matchedKeys[i]!
        const raw = await idbRequest(store.get(k))
        if (!raw) continue

        let envelope: EncryptedEnvelope
        let id: string
        if (obfuscate && typeof raw === 'object' && '_e' in (raw as StoredValue)) {
          const stored = raw as StoredValue
          envelope = stored._e
          id = xorDecode(stored._oi, obfKey)
        } else {
          envelope = raw as EncryptedEnvelope
          id = k.slice(pfx.length)
        }
        items.push({ id, envelope })
      }

      await complete // family#165
      return {
        items,
        nextCursor: end < matchedKeys.length ? String(end) : null,
      }
    },
  }
}
