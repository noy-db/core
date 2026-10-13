/**
 * Stores that are WRONG in exactly one way each — the controls for
 * `reference.test.ts` (core#46).
 *
 * ⚠️ NOT a `.test.ts`, and neither are the suites beside it: they are run by a
 * CHILD vitest from `kit-contract.test.ts`, which reads their exit code as
 * evidence. A suite that is evidence ABOUT a failure must not be able to fail
 * the suite that reads it, and the main run collects only `*.test.ts`.
 *
 * ⭐ ONE DEFECT PER FIXTURE, and each is a single override over a store that is
 * otherwise hub's own. That is what makes a red run attributable: if a broken
 * fixture differed from the reference in two ways, a failing case would not say
 * WHICH assertion is alive — the same trap the ceremony kit's
 * `wrongMethodSlot` rule exists to prevent ("two differences means the case
 * proves only that *something* rejected it").
 */
import { memoryStore } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope } from '@noy-db/hub/to'

/**
 * Accepts any `expectedVersion`. A store that does this loses optimistic
 * concurrency silently: every conflicting write wins, last-writer-take-all,
 * with no error anywhere for hub to react to.
 */
export function ignoresExpectedVersion(): NoydbStore {
  const inner = memoryStore()
  return {
    ...inner,
    async put(vault, collection, id, envelope, _expectedVersion?: number) {
      return await inner.put(vault, collection, id, envelope)
    },
  }
}

/**
 * Drops `_del` on the way in. The delete marker is how #589 convergence works;
 * a store that strips it round-trips every *normal* envelope perfectly and
 * resurrects deleted records on the next sync.
 */
export function dropsDeleteMarker(): NoydbStore {
  const inner = memoryStore()
  return {
    ...inner,
    async put(vault, collection, id, envelope: EncryptedEnvelope, expectedVersion?: number) {
      const { _del: _dropped, ...stripped } = envelope as EncryptedEnvelope & { _del?: true }
      return await inner.put(vault, collection, id, stripped as EncryptedEnvelope, expectedVersion)
    },
  }
}

/**
 * Implements `tx()` and does NOT declare `capabilities.txAtomic` — the exact
 * drift `@noy-db/to-memory` shipped, where a working transaction implementation
 * was never delegated to because hub gates on the bit rather than on the
 * method. Everything else about this store is correct, which is the point: no
 * case in the suite can see this except the pairing assertion.
 */
export function undeclaredTx(): NoydbStore {
  const inner = memoryStore({ full: true })
  const declared = inner.capabilities
  if (!declared) {
    // Not defensive padding: if the full store ever stops declaring
    // capabilities at all, hiding one is no longer the defect this control
    // describes, and it would go on "passing" by failing for another reason.
    throw new Error('memoryStore({ full: true }) declares no capabilities — this control is stale')
  }
  const { txAtomic: _hidden, ...rest } = declared
  return { ...inner, capabilities: rest }
}

/**
 * Resolves `vault/collection/id` the way a hierarchical namespace does, so a
 * `..` component in the ID climbs out of its collection and then its vault —
 * the exact defect family#133 found in `to-file`, where `join` collapses `..`
 * rather than refusing it.
 *
 * ⭐ Broken in exactly ONE way, and that took a second attempt: the first
 * version re-addressed every key into one shared namespace, which also broke
 * `list`, `loadAll`, `saveAll` and isolation — eight failing cases, so the
 * control attributed nothing. An ordinary triple must resolve to ITSELF here;
 * only a climbing id may move.
 */
export function escapesNamespace(): NoydbStore {
  const inner = memoryStore()
  const resolveTriple = (vault: string, collection: string, id: string): [string, string, string] => {
    const out: string[] = []
    for (const part of `${vault}/${collection}/${id}`.split('/')) {
      if (part === '.') continue
      if (part === '..') { out.pop(); continue }
      out.push(part)
    }
    // Degenerate only once `..` has consumed the vault and collection.
    return [out[0] ?? '_root', out[1] ?? '_root', out.slice(2).join('/') || '_root']
  }
  return {
    ...inner,
    async get(vault, collection, id) { return await inner.get(...resolveTriple(vault, collection, id)) },
    async put(vault, collection, id, envelope: EncryptedEnvelope, expectedVersion?: number) {
      const [v, c, k] = resolveTriple(vault, collection, id)
      return await inner.put(v, c, k, envelope, expectedVersion)
    },
    async delete(vault, collection, id) { return await inner.delete(...resolveTriple(vault, collection, id)) },
  }
}

/**
 * ⛔ A CONTROL for family#147's `saveAll` half: a store whose `saveAll` MERGES
 * instead of replacing.
 *
 * ⭐ This is the shape every existing bulk case passed, which is why the control
 * exists at all — `saveAll writes all collections` and the `loadAll` round-trip
 * both write into an empty vault, so additive and replacing implementations are
 * indistinguishable to them. to-file really was additive until family#147.
 *
 * The defect is ONE thing: nothing is dropped first. An ordinary snapshot into an
 * empty vault still behaves identically, so the cases that are not about
 * replacement stay green and the failing count stays the attribution.
 */
export function mergesOnSaveAll(): NoydbStore {
  const inner = memoryStore()
  return {
    ...inner,
    async saveAll(vault, data) {
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          await inner.put(vault, collection, id, envelope)
        }
      }
    },
  }
}

/**
 * family#217 — the `to-file` defect shape, in a Map: ids are resolved
 * case-insensitively onto an existing entry (what a case-folding filesystem
 * does), and `saveAll` writes FOLDED while pruning by the snapshot's own key
 * names. The two together lose both records, which is what shipped:
 *
 *   put('Abc')                   -> entry 'Abc'
 *   saveAll({ coll1: { abc } })  -> folds 'abc' onto 'Abc', so 'Abc' now holds
 *                                   abc's body; then prunes 'Abc', because the
 *                                   snapshot says 'abc'
 *   list() -> []
 *
 * ⛔ The REPLACE semantics are kept faithful on purpose — absent collections
 * and empty record sets are still emptied — so this fixture is broken in
 * exactly one way and attributes to the case-folding case alone. Reproducing
 * the defect by also breaking replacement would redden family#147's cases too
 * and attribute nothing; see `kit-contract.test.ts`'s header.
 */
export function foldsCaseAndPrunes(): NoydbStore {
  const inner = memoryStore()
  const fold = async (vault: string, collection: string, id: string): Promise<string> => {
    const existing = await inner.list(vault, collection)
    return existing.find((e) => e.toLowerCase() === id.toLowerCase()) ?? id
  }
  return {
    ...inner,
    async put(vault, collection, id, envelope, expectedVersion) {
      return inner.put(vault, collection, await fold(vault, collection, id), envelope, expectedVersion)
    },
    async get(vault, collection, id) {
      return inner.get(vault, collection, await fold(vault, collection, id))
    },
    async delete(vault, collection, id) {
      return inner.delete(vault, collection, await fold(vault, collection, id))
    },
    async saveAll(vault, data) {
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          await inner.put(vault, collection, await fold(vault, collection, id), envelope)
        }
      }
      // Prune against the snapshot's UNFOLDED keys — the knife.
      const held = await inner.loadAll(vault)
      for (const [collection, records] of Object.entries(held)) {
        if (collection.startsWith('_')) continue
        const keep = data[collection]
        for (const id of Object.keys(records)) {
          if (keep === undefined || !(id in keep)) await inner.delete(vault, collection, id)
        }
      }
    },
  }
}
