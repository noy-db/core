/**
 * Skip re-writing materialized-view output rows whose content has not changed
 * (#1418).
 *
 * `MaterializedViewExecutor.refresh()` recomputes the whole view and then
 * writes EVERY output row, on every source write. Measured on one MV with a
 * single union arm, writing rows the MV's own `map` drops:
 *
 *     250 receipts / 250 bills   →  23.0 ms per source write
 *     450 receipts / 450 bills   →  41.6 ms per source write
 *
 * 1.8x the sources, 1.8x the cost — because the thing that grew was the OUTPUT
 * ROW COUNT, and each row is an encrypt-and-store round trip. The query and the
 * aggregation are not where the time goes.
 *
 * ## Why this, and not "skip the refresh when the row maps to nothing"
 *
 * The issue proposed short-circuiting the refresh when the written row's `map`
 * returns null. That cannot be built as stated, and the reason is worth
 * recording so nobody re-attempts it:
 *
 *  1. `materializeUnionResult` feeds `map` rows from `coll.query().toArray()`,
 *     which applies `decodeVia` — money arrives as a canonical decimal string,
 *     not the stored scaled integer. Probing `arm.map(writtenRecord)` at
 *     dispatch time hands `map` a DIFFERENTLY SHAPED row, so any `map` that
 *     filters on a money field can answer `null` where the real pipeline would
 *     not. The view then silently stops updating, which is far worse than the
 *     latency it was meant to fix.
 *  2. Skipping also requires that the row contributed nothing BEFORE, or an
 *     update that removes a row from the view is dropped. The prior record is
 *     not passed to the dispatcher, and is a stored record, so it hits (1)
 *     twice over.
 *  3. An arm with `join` legs has the right side attached before `map` runs, so
 *     a probe would have to resolve the legs too.
 *
 * Comparing the row we are ABOUT to write against the row we LAST wrote sides
 * steps all three. It needs no prior record, it is form-agnostic (query, union
 * and projection all benefit), and it degrades to the right thing: a write that
 * changes one group rewrites one row instead of all of them.
 *
 * ## Why the entries are canonical strings and not short hashes
 *
 * A hash collision here means a row that is never rewritten — a silently stale
 * view with no symptom. At the 20k-row cap below, an 8-byte hash carries a
 * couple of percent chance of one collision somewhere, which is not a trade
 * worth making for memory. So entries hold the full canonical string, and
 * memory is bounded by refusing to memoize a view larger than the cap.
 *
 * ## Why a mutation stamp, and what it does NOT cover
 *
 * The memo is only sound while nothing else writes the output collection —
 * tombstoning, `invalidateMVAtRest`, forget/erase and sync cut-over all can. So
 * a refresh records the output collection's mutation stamp AFTER its writes,
 * and the next refresh discards the whole set unless the stamp is still where
 * it left it. That is a "nobody else touched this" test rather than an
 * enumeration of writers — the same reasoning that made #1417's keyset memo and
 * #1426's slot guard safe, and it does not rot when a new writer is added.
 *
 * ⚠️ It covers writers that go THROUGH the output `Collection`. A writer that
 * bypasses it and edits the store directly moves neither the stamp nor the
 * collection's own cache — but such a writer already makes `list()` on that
 * collection wrong, so it is a broader defect than this memo.
 *
 * ## ⛔ There is no explicit drop, and that is the design (#59)
 *
 * Invalidation is BY STAMP, in both directions: `readEmitMemo` deletes a memo
 * whose stamp no longer matches, and `writeEmitMemo` deletes rather than store
 * one it cannot trust (`null` stamp, or over the row cap). A refresh that
 * throws midway has already written some rows, so the output collection's
 * stamp has moved and the next read drops the memo itself; a row that failed,
 * was declined or was tombstoned is simply absent from `emitted` and is written
 * again (`executor.ts`, "Record the stamp AFTER every write and tombstone").
 *
 * So there is no invalidation path the stamp guard does not already cover. A
 * `dropEmitMemo(key)` hook existed until #59 and was called by nothing for
 * exactly that reason — do not re-add one without first naming the path that
 * leaves a stale memo behind.
 *
 * ## ⛔ The memo stands down when a REDUNDANT write is still observable
 *
 * `Collection._cacheStamp` returns `null` — no memo — whenever writing the same
 * bytes again would have an effect beyond the stored bytes. This is the half
 * that is easy to get wrong, and it was found by a failing test rather than by
 * reasoning, so the cases are recorded:
 *
 *  - **A `beforePut` gate handler.** Measured: with `withPeriods()` and a
 *    closed period, an unchanged MV row previously produced a
 *    `PeriodClosedError` from `put`, which `putDerivedOutput` converts into a
 *    `derivation:skipped-frozen` event and an audit record. Skipping the write
 *    silences that — `written=0 skipped=2 events=0` where the suite expects one
 *    event. A performance change must not quietly narrow a compliance signal.
 *  - **Explicit history.** A put records a version, so skipping changes what
 *    `history()` returns. (Arguably an improvement — 450 identical versions per
 *    source write is not useful — but that is a product call, not this one.)
 *  - **Sync (`onDirty`) and the search index.** Both mark state from the fact
 *    that a write happened, independently of what was written.
 *  - **Lazy mode**, which has no eager cache to stamp.
 *
 * The asymmetry is what makes this the right default: opting out costs the old
 * write path, opting in wrongly changes behaviour with no symptom at all.
 *
 * ⭐ So an MV whose OUTPUT collection carries periods, history, sync or search
 * gets no speedup. That is deliberate, and it is the first thing to check when
 * this fix appears not to help a real workload — the answer is per output
 * collection, not per vault.
 *
 * ⛔ A row is recorded ONLY when the write actually landed. A `putDerivedOutput`
 * that declines (the frozen-period skip) or throws leaves no entry, so the next
 * refresh writes it again rather than believing a row exists that does not.
 *
 * @module
 */
import { canonicalizeQueryPlan } from './query-hash.js'

/**
 * Views larger than this are not memoized at all. The memo would otherwise
 * hold a canonical string per row for the process's life, and a view this size
 * is dominated by its write cost in ways one skip cannot rescue.
 */
const MAX_MEMOIZED_ROWS = 20_000

interface EmitMemo {
  /** The output collection's mutation stamp when this set was written. */
  readonly stamp: number
  /** `outputId -> canonical content string` for rows this MV actually wrote. */
  readonly rows: Map<string, string>
}

const memos = new Map<string, EmitMemo>()

/**
 * Identity of one MV's output, per vault — MV names are not globally unique.
 *
 * ⚠️ `\0` written as the ESCAPE, not as a raw byte. A raw NUL in the source
 * makes git classify the whole file as binary, so it stops diffing and stops
 * being reviewable — caught here by a `Bin 0 -> 8811 bytes` line in a diffstat.
 * The separator itself is right: no vault or collection name can contain one.
 */
export function emitMemoKey(vault: string, mvName: string, outputCollection: string): string {
  return `${vault}\0${mvName}\0${outputCollection}`
}

/**
 * The rows this MV last wrote, or `null` when the memo cannot be trusted —
 * nothing recorded yet, or the output collection moved under us.
 *
 * `stamp` of `null` means the collection cannot supply one (lazy mode), which
 * is treated as "no memo" rather than "unchanged".
 */
export function readEmitMemo(key: string, stamp: number | null): ReadonlyMap<string, string> | null {
  if (stamp === null) return null
  const hit = memos.get(key)
  if (!hit || hit.stamp !== stamp) {
    // Someone else wrote the output collection. Everything we believed about
    // its contents is now a guess, so drop all of it rather than reconcile.
    if (hit) memos.delete(key)
    return null
  }
  return hit.rows
}

/** Record what this refresh actually left on disk. A `null` stamp records nothing. */
export function writeEmitMemo(key: string, stamp: number | null, rows: Map<string, string>): void {
  if (stamp === null || rows.size > MAX_MEMOIZED_ROWS) {
    memos.delete(key)
    return
  }
  memos.set(key, { stamp, rows })
}

/**
 * A canonical string for the row a refresh is about to write, or `null` when no
 * safe one exists.
 *
 * The MV's `queryHash` is folded in so a strategy change rewrites every row
 * even where the projected content happens to match — a row carrying a stale
 * `_materializedFrom.queryHash` is stale by definition (`stale.ts`).
 *
 * `_materializedFrom` itself is excluded: its `materializedAt` moves on every
 * refresh, so including it would make every comparison differ and the memo a
 * pure cost.
 *
 * ⛔ Returns `null` rather than throwing on anything `JSON.stringify` refuses
 * (a `BigInt`, a cycle). Declining to memoize costs the old write; guessing
 * costs a stale view.
 */
export function rowContentKey(row: Record<string, unknown>, queryHash: string): string | null {
  try {
    // `_materializedFrom` is excluded by rebuilding without it rather than by
    // destructuring into an unused binding — same result, no dead name.
    const content: Record<string, unknown> = {}
    for (const k of Object.keys(row)) {
      if (k !== '_materializedFrom') content[k] = row[k]
    }
    return `${queryHash}\0${canonicalizeQueryPlan(content)}`
  } catch {
    return null
  }
}

/** Test seam — the process-wide memo must not leak between test cases. */
export function _clearEmitMemos(): void {
  memos.clear()
}
