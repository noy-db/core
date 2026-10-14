/**
 * Vault-level diff orchestrator.
 *
 * Compares a live `Vault`'s plaintext state against a candidate state
 * (another vault, a plain `{ collection: records[] }` map, or a vault
 * dump JSON) and returns a structured `VaultDiff` plan listing the
 * records that would be added, modified, or deleted to bring the live
 * vault into the candidate's shape.
 *
 * Builds on two existing record-level helpers:
 *
 *   1. `diff(a, b)` from `./history/diff.ts` — emits dot-pathed
 *      `DiffEntry[]` with `type: 'added' | 'removed' | 'changed'` for
 *      each changed field of two records. Used here for the
 *      `fieldDiffs` of every `modified` entry, and (with empty result)
 *      as the default deep-equal check.
 *
 *   2. `Vault.exportStream()` from `./vault.ts` — the canonical
 *      decrypt-and-stream-records iterator. Used to walk both sides
 *      when the candidate is itself a `Vault`. ACL-scoped: collections
 *      the caller can't read silently drop out, the same way every
 *      other plaintext-emitting export pipeline filters them.
 *
 * The new orchestration is the **vault-level** enumeration: bucket
 * each record id into added (only in candidate), deleted (only in
 * vault), or modified (in both with field changes); leave the
 * field-level granularity to the existing `diff()`.
 *
 * Use cases:
 *
 *   - Import preview (`@noy-db/as-*` `fromString` returns a plan
 *     whose body is a `VaultDiff`).
 *   - Backup verification ("does this `.noydb` bundle from yesterday
 *     match the current vault?").
 *   - Two-vault reconciliation ("what's different between Office A
 *     and Office B before we sync?").
 *   - Test assertions (golden-file testing with one-liner
 *     `expect(plan.summary).toEqual(...)`).
 *
 * @module
 */

import type { Vault } from '../kernel/vault.js'
import { diff as fieldDiff, type DiffEntry as FieldDiffEntry } from '../with-commit/history/diff.js'

// ─── Public types ──────────────────────────────────────────────────────

/** Per-record entry shape — added and deleted records carry only the record value. */
export interface VaultDiffEntry<T = unknown> {
  readonly collection: string
  readonly id: string
  readonly record: T
  /**
   * Unencrypted envelope metadata for the RECEIVER-side record.
   * Populated only when `diffVault` is called with `{includeMetadata: true}`.
   * Default: `undefined` (zero extra reads, no behavior change).
   *
   * Populated for `modified` (the CURRENT receiver state, before the candidate
   * is applied) and `deleted` (the receiver envelope of the record being
   * removed). `added` entries have no receiver envelope at diff time, so their
   * `metadata` is always absent.
   */
  readonly metadata?: {
    readonly version: number
    readonly timestamp: string
    readonly by?: string
    readonly source?: string
    readonly sourceTs?: string
  }
}

/** Modified records carry both halves of the diff plus the field-level breakdown. */
export interface VaultDiffModifiedEntry<T = unknown> extends VaultDiffEntry<T> {
  /** The record as it stands in the live vault. */
  readonly before: T
  /** Top-level keys whose values differ between `before` and `record`. */
  readonly fieldsChanged: readonly string[]
  /**
   * Field-level diff entries from `diff(before, record)`. Reuses the
   * existing per-record diff helper so consumers can render git-style
   * `path: from → to` rows without re-walking the records.
   */
  readonly fieldDiffs: readonly FieldDiffEntry[]
}

export interface VaultDiff<T = unknown> {
  readonly added: readonly VaultDiffEntry<T>[]
  readonly modified: readonly VaultDiffModifiedEntry<T>[]
  readonly deleted: readonly VaultDiffEntry<T>[]
  /** Only populated when `options.includeUnchanged: true`. */
  readonly unchanged: readonly VaultDiffEntry<T>[] | undefined
  readonly summary: {
    readonly add: number
    readonly modify: number
    readonly delete: number
    readonly total: number
    /** family#151 — `skipped.length`, so a caller reading only the summary sees it. */
    readonly skipped: number
  }
  /**
   * Records this diff could not key, and therefore says nothing about
   * (family#151). Empty for a vault-to-vault diff. ⚠️ A non-empty value means
   * the diff is INCOMPLETE — an importer walking only the buckets will not
   * write these rows, which used to happen silently.
   */
  readonly skipped: readonly VaultDiffSkipped[]
  /**
   * Format the diff as a human-readable string.
   *
   *   - `'count'`   — one line, just the numbers (`12 added · 3 modified · 0 deleted`)
   *   - `'one-line'` — count plus a single overview line
   *   - `'full'`    — count + one row per added/modified/deleted record (default)
   */
  format(opts?: { detail?: 'count' | 'one-line' | 'full' }): string
}

export interface DiffOptions {
  /** Restrict the diff to a subset of collections. */
  readonly collections?: readonly string[]
  /** Field on each record that carries its id. Defaults to `'id'`. */
  readonly idKey?: string
  /** Override the default deep-equal check for "modified vs unchanged". */
  readonly compareFn?: (a: unknown, b: unknown) => boolean
  /** If true, include unchanged records in the diff (off by default to save memory). */
  readonly includeUnchanged?: boolean
  /**
   * When `true`, each entry in `added`, `modified`, and `deleted` will carry a
   * `metadata` field with the RECEIVER-side envelope metadata
   * (`version`, `timestamp`, `by?`, `source?`, `sourceTs?`).
   *
   * Off by default — no extra adapter reads, no behavior change for existing callers.
   */
  readonly includeMetadata?: boolean
}

/**
 * Candidate state to diff the vault against:
 *
 *   - A `Vault` instance — both sides are walked via `exportStream()`.
 *   - A `Record<collection, records[]>` map — same shape `as-json.toObject()`
 *     produces. Useful for diffing parsed file content against the live vault.
 *   - A `VaultDump` (output of `vault.dump()`) — a JSON string carrying the
 *     full vault state. Parsed and reduced to the map shape above.
 */
/**
 * A record neither side could key, and therefore one this diff does NOT report
 * on (family#151).
 *
 * ⛔ IT EXISTS BECAUSE THE SKIP WAS SILENT. A record with no `idKey` field was
 * dropped from the map on both sides, so it appeared in no bucket — and
 * `@noy-db/hub/as`'s `plan().apply()` walks only `added`/`modified`/`deleted`.
 * An import therefore did not write it, with no error and no count. A diff that
 * omits a record is reporting a difference it did not find.
 *
 * ⚠️ Only reachable on the object/string candidate path. A vault-to-vault diff
 * keys both sides by the hub id, which every record has.
 */
export interface VaultDiffSkipped {
  readonly collection: string
  readonly side: 'vault' | 'candidate'
  /** Position within that side's record list for the collection. */
  readonly index: number
}

export type DiffCandidate<T = unknown> =
  | Vault
  | Record<string, readonly T[]>
  | string

// ─── Implementation ────────────────────────────────────────────────────

/**
 * Compute the diff between a live vault and a candidate state.
 *
 * Ungated shared import/merge infrastructure: the `as-*` exporters call this
 * internally from their `fromString`/import merge logic, so it is always
 * available (not behind `withCargo()`). Only `extractPartition` is a gated
 * cargo capability.
 *
 * Returns a fully buffered `VaultDiff` — no streaming. Memory cost is
 * O(n + m) in the row count of vault + candidate. For documented
 * 1K-50K-record vaults this is fine; a streaming variant lands as a
 * follow-up if a > 100K-record consumer arrives.
 */
export async function diffVault<T = unknown>(
  vault: Vault,
  candidate: DiffCandidate<T>,
  options: DiffOptions = {},
): Promise<VaultDiff<T>> {
  const idKey = options.idKey ?? 'id'
  const filter = options.collections ? new Set(options.collections) : null
  const compareFn =
    options.compareFn ?? ((a: unknown, b: unknown) => fieldDiff(a, b).length === 0)

  // Side A — walk the live vault via exportStream(). Each chunk arrives
  // already decrypted and ACL-scoped, so collections the caller can't
  // read silently drop out. exportStream's records are typed `unknown[]`
  // — diffVault is the type-erasure boundary; the caller asserts the
  // record shape via the function's `<T>` generic.
  const live = new Map<string, Map<string, T>>()
  const skipped: VaultDiffSkipped[] = []
  // ⭐ family#151 — key by the HUB ID when the candidate can supply one too.
  // A record need not carry an `id` field: hub's id is the store key, not a
  // property of the plaintext. Keying both sides on a FIELD meant every id-less
  // record was dropped from BOTH maps by the `continue` below — so it landed in
  // no bucket, and `as`'s `apply()` walks only the buckets. An import silently
  // did not write it: no error, no count, nothing.
  //
  // ⛔ ONLY WHEN BOTH SIDES CAN. A `Record<collection, records[]>` or a
  // `dump()` string carries no hub ids at all, so keying the live side by hub
  // id against a field-keyed candidate would mismatch EVERY record and report
  // the whole vault added-and-deleted. That asymmetry is the real blocker for
  // round-tripping an id-less record through `/as`, and it is a format question
  // (`exportVaultJSON` emits `records: [...]`, dropping the id), not one
  // `diffVault` can answer. Reported, not papered over.
  // ⚠️ TWO QUESTIONS, and `byHubId` used to answer both with one flag
  // (family#175). `normaliseCandidate` branches on it to call
  // `candidate.exportStream()`, so it means "the candidate IS a Vault"; the
  // loop below uses it to mean "key the live side by hub id". Those came apart
  // the moment an artefact could carry ids: keying the candidate by hub id
  // while the live side keyed by a record FIELD would mismatch every record
  // whose id field differs from its store key — exactly the id-less record
  // this row is about — and report the vault added-and-deleted.
  const candidateIsVault = isVaultCandidate(candidate)
  const keyByHubId = candidateIsVault || artefactCarriesIds(candidate)
  for await (const chunk of vault.exportStream({ granularity: 'collection' })) {
    if (filter && !filter.has(chunk.collection)) continue
    const collection = live.get(chunk.collection) ?? new Map<string, T>()
    chunk.records.forEach((record, i) => {
      const id = keyByHubId ? (chunk.ids?.[i] ?? '') : readIdField(record, idKey)
      if (!id) {
        skipped.push({ collection: chunk.collection, side: 'vault', index: i })
        return
      }
      collection.set(id, record as T)
    })
    live.set(chunk.collection, collection)
  }

  // Side B — normalise the candidate into the same shape.
  const cand = await normaliseCandidate<T>(candidate, idKey, filter, candidateIsVault, skipped)

  // Walk every (collection, id) on either side and bucket.
  const added: VaultDiffEntry<T>[] = []
  const modified: VaultDiffModifiedEntry<T>[] = []
  const deleted: VaultDiffEntry<T>[] = []
  const unchanged: VaultDiffEntry<T>[] | undefined = options.includeUnchanged ? [] : undefined

  const collectionNames = new Set([...live.keys(), ...cand.keys()])
  for (const collection of [...collectionNames].sort()) {
    const liveColl = live.get(collection) ?? new Map<string, T>()
    const candColl = cand.get(collection) ?? new Map<string, T>()
    const allIds = new Set([...liveColl.keys(), ...candColl.keys()])

    for (const id of [...allIds].sort()) {
      const before = liveColl.get(id)
      const after = candColl.get(id)

      if (before === undefined && after !== undefined) {
        // added: record only in candidate — no receiver envelope
        added.push({ collection, id, record: after })
      } else if (before !== undefined && after === undefined) {
        // deleted: record only in receiver — attach metadata if requested
        const metadata = options.includeMetadata
          ? (await vault.collection(collection).getMetadata(id)) ?? undefined
          : undefined
        deleted.push({ collection, id, record: before, ...(metadata !== undefined ? { metadata } : {}) })
      } else if (before !== undefined && after !== undefined) {
        if (compareFn(before, after)) {
          unchanged?.push({ collection, id, record: after })
        } else {
          // modified: record in both — attach receiver-side metadata if requested
          const metadata = options.includeMetadata
            ? (await vault.collection(collection).getMetadata(id)) ?? undefined
            : undefined
          const fieldDiffs = fieldDiff(before, after)
          const fieldsChanged = uniqueTopLevelKeys(fieldDiffs)
          modified.push({
            collection,
            id,
            record: after,
            before,
            fieldsChanged,
            fieldDiffs,
            ...(metadata !== undefined ? { metadata } : {}),
          })
        }
      }
    }
  }

  const summary = {
    add: added.length,
    modify: modified.length,
    delete: deleted.length,
    total: added.length + modified.length + deleted.length,
    skipped: skipped.length,
  }

  return {
    added,
    modified,
    deleted,
    unchanged,
    skipped,
    summary,
    format(opts) {
      return formatDiff(opts?.detail ?? 'full', { added, modified, deleted, summary })
    },
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

/**
 * Is the candidate a live `Vault`? Duck-typed via `exportStream` — matching
 * vault.ts's structural shape without an `instanceof` that would import the
 * class and risk a circular dep.
 *
 * ⚠️ Hoisted out of `normaliseCandidate` by family#151 because the ANSWER
 * decides how the LIVE side is keyed, which is computed before the candidate is
 * normalised. The two sides must agree or every record mismatches.
 */
/**
 * family#175 — does this artefact carry hub ids? Decides whether the LIVE side
 * keys by hub id, so both sides agree.
 *
 * ⚠️ Parses a string candidate that `normaliseCandidate` will parse again.
 * Deliberate: `diffVault` is host-side tooling, not a hot path, and threading
 * one parse through both would make the vault/string/object dispatch depend on
 * a pre-parsed value it does not otherwise need. Correctness first; if an
 * artefact ever gets big enough for this to matter, hoist the parse then.
 */
function artefactCarriesIds(candidate: unknown): boolean {
  let raw: unknown = candidate
  if (typeof candidate === 'string') {
    try { raw = JSON.parse(candidate) } catch { return false }
  }
  if (raw === null || typeof raw !== 'object') return false
  const nested = (raw as { collections?: unknown }).collections
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return false
  return Object.values(nested).some(
    (body) => Array.isArray((body as { ids?: unknown } | null)?.ids),
  )
}

function isVaultCandidate(candidate: unknown): boolean {
  return typeof candidate === 'object'
    && candidate !== null
    && 'exportStream' in candidate
    && typeof (candidate as Vault).exportStream === 'function'
}

async function normaliseCandidate<T>(
  candidate: DiffCandidate<T>,
  idKey: string,
  filter: Set<string> | null,
  byHubId: boolean,
  skipped: VaultDiffSkipped[],
): Promise<Map<string, Map<string, T>>> {
  const out = new Map<string, Map<string, T>>()

  if (byHubId) {
    for await (const chunk of (candidate as Vault).exportStream({ granularity: 'collection' })) {
      if (filter && !filter.has(chunk.collection)) continue
      const collection = out.get(chunk.collection) ?? new Map<string, T>()
      chunk.records.forEach((record, i) => {
        const id = chunk.ids?.[i] ?? ''
        if (!id) {
          skipped.push({ collection: chunk.collection, side: 'candidate', index: i })
          return
        }
        collection.set(id, record as T)
      })
      out.set(chunk.collection, collection)
    }
    return out
  }

  // String — assume a vault.dump() JSON string. Parse and reduce to the map shape.
  if (typeof candidate === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch (err) {
      throw new Error(
        `diffVault: candidate string is not valid JSON (${(err as Error).message})`,
      )
    }
    return collectionsFromObject<T>(parsed, idKey, filter, skipped)
  }

  // Plain object — `Record<collection, records[]>` (same shape as-json.toObject() returns).
  return collectionsFromObject<T>(candidate, idKey, filter, skipped)
}

/**
 * family#175 — normalise the two candidate artefact shapes to
 * `[collection, records, ids?]`.
 *
 * ⭐ `dump()`-like flat (`{ <coll>: records[] }`) and `exportVaultJSON`'s
 * nested (`{ collections: { <coll>: { records, ids } } }`). Kept as one
 * function so a third shape has an obvious home, and so the caller cannot
 * accidentally handle one and not the other — which is precisely what
 * happened.
 */
function flattenCandidateShape(
  raw: object,
): Array<readonly [string, unknown, readonly string[] | undefined]> {
  const nested = (raw as { collections?: unknown }).collections
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return Object.entries(nested).map(([name, body]) => {
      const b = body as { records?: unknown; ids?: readonly string[] } | null
      return [name, b?.records, b?.ids] as const
    })
  }
  return Object.entries(raw).map(([name, value]) => [name, value, undefined] as const)
}

function collectionsFromObject<T>(
  raw: unknown,
  idKey: string,
  filter: Set<string> | null,
  skipped: VaultDiffSkipped[],
): Map<string, Map<string, T>> {
  const out = new Map<string, Map<string, T>>()
  if (raw === null || typeof raw !== 'object') {
    throw new Error('diffVault: candidate must be a Vault, an object, or a JSON string')
  }
  // A vault dump JSON has a top-level shape like { _compartment, _keyring, <coll>: <records[]> }.
  // We accept both: keys starting with `_` are skipped (they're metadata), the rest are collections.
  // family#175 — TWO artefact shapes reach here, and recognising only one was
  // a silent data-loss hazard rather than a missing feature.
  //
  // ⛔ `exportVaultJSON` nests its records under `collections: { <coll>:
  // { schema, refs, records, ids } }`, while this loop required the top-level
  // value to BE the array (the `dump()`-like flat shape). So `collections` was
  // not an array, `continue` skipped it, the candidate parsed as EMPTY — and
  // diffing a vault against ITS OWN export reported every record as DELETED,
  // with `skipped: 0`, so nothing signalled a problem. Applying that diff
  // would have emptied the vault. Measured on main before this change:
  // `{ add: 0, modify: 0, delete: 2, skipped: 0 }` for a two-record vault.
  const entries = flattenCandidateShape(raw)
  for (const [key, value, ids] of entries) {
    if (key.startsWith('_')) continue
    if (filter && !filter.has(key)) continue
    if (!Array.isArray(value)) continue
    const collection = new Map<string, T>()
    ;(value as readonly T[]).forEach((record, i) => {
      // family#175 — the HUB ID when the artefact carries one, which is what
      // lets an id-less record round-trip. `ids[i]` identifies `records[i]`
      // positionally; see `exportVaultJSON`.
      const hubId = ids?.[i]
      if (hubId !== undefined && hubId !== '') {
        collection.set(hubId, record)
        return
      }
      // family#151 — RECORDED, not dropped. A candidate row with no `idKey`
      // field lands in no bucket, and `as`'s `apply()` walks only the buckets,
      // so the row was silently never imported. This path cannot key by hub id
      // (a plain object carries none), so the honest fix is to make the skip
      // observable instead of pretending the row did not exist.
      if (record === null || typeof record !== 'object') {
        skipped.push({ collection: key, side: 'candidate', index: i })
        return
      }
      const id = readIdField(record, idKey)
      if (!id) {
        skipped.push({ collection: key, side: 'candidate', index: i })
        return
      }
      collection.set(id, record)
    })
    out.set(key, collection)
  }
  return out
}

function uniqueTopLevelKeys(diffs: readonly FieldDiffEntry[]): readonly string[] {
  const keys = new Set<string>()
  for (const d of diffs) {
    // path is dot-separated; the top-level key is everything before the
    // first `.` or `[`. (`a.b.c` → `a`, `tags[0]` → `tags`, `(root)` → `(root)`).
    const m = /^[^.[]+/.exec(d.path)
    if (m) keys.add(m[0])
  }
  return [...keys]
}

/**
 * Pull the id field off a record without going through `String(obj)`,
 * which would emit `[object Object]` for nested objects and silently
 * collapse rows that share the same parent. Only string and number ids
 * are accepted; anything else returns the empty string and the record
 * is skipped at the call site.
 */
function readIdField(record: unknown, idKey: string): string {
  if (record === null || typeof record !== 'object') return ''
  const v = (record as Record<string, unknown>)[idKey]
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

interface FormatBuckets<T> {
  readonly added: readonly VaultDiffEntry<T>[]
  readonly modified: readonly VaultDiffModifiedEntry<T>[]
  readonly deleted: readonly VaultDiffEntry<T>[]
  readonly summary: VaultDiff<T>['summary']
}

function formatDiff<T>(
  detail: 'count' | 'one-line' | 'full',
  b: FormatBuckets<T>,
): string {
  // family#151 — a skip is in EVERY detail level, including 'count'. The whole
  // defect was that these rows were invisible, and `format()` is what a human
  // reads before approving an import; "0 added" with rows quietly unimportable
  // is the sentence this is meant to stop being printable.
  const skipNote = b.summary.skipped > 0 ? ` · ${b.summary.skipped} SKIPPED (unkeyable)` : ''
  const head = `${b.summary.add} added · ${b.summary.modify} modified · ${b.summary.delete} deleted${skipNote}`
  if (detail === 'count') return head
  if (b.summary.total === 0) return head + (b.summary.skipped > 0 ? '' : '\n(no changes)')
  if (detail === 'one-line') return head

  const rows: string[] = [head, '']
  for (const e of b.added) rows.push(`${e.collection}/${e.id}\tadded`)
  for (const e of b.modified) {
    const fields = e.fieldDiffs
      .map((f) => `${f.path}: ${shortJSON(f.from)} → ${shortJSON(f.to)}`)
      .join(', ')
    rows.push(`${e.collection}/${e.id}\tmodified\t${fields}`)
  }
  for (const e of b.deleted) rows.push(`${e.collection}/${e.id}\tdeleted`)
  return rows.join('\n')
}

function shortJSON(value: unknown): string {
  if (value === undefined) return 'undefined'
  const s = JSON.stringify(value)
  // JSON.stringify returns string for any JSON value except `undefined`
  // (handled above), `function`, and `symbol`. Fall back to a static
  // tag for those — never let an arbitrary object hit the default
  // stringifier (which the lint rule explicitly bans).
  if (typeof s !== 'string') return '<unrepresentable>'
  return s.length > 60 ? s.slice(0, 57) + '...' : s
}
