---
"@noy-db/hub": patch
---

materialized views: a changed definition is now detected on reopen (family#204)

`queryHash` was **written and never read**. `query-hash.ts` says it exists "to
detect strategy drift: a row whose `_materializedFrom.queryHash` doesn't match
the current strategy is considered stale", and `registry.ts` claimed a predicate
change "forces refresh on next visit" — but nothing anywhere compared it. Every
`_materializedFrom` read was for `mvName`, for ownership.

So a changed definition went undetected on reopen: the view kept serving rows
materialized under the old definition until an unrelated source write happened
to refresh it.

⭐ **Marking the MV stale is the whole fix.** Everything downstream already
existed: `resolveStaleMVOnRead` recomputes via `executor.refresh`, and the
executor's tombstone leg deletes any stamped row absent from the new id set,
with `onEmpty` defaulting to `'delete'`. No new purge path and no new storage
record.

It runs inside `hydratePersistedStaleMarkers`, which already executes **once per
cold session** on the first MV read — so there is no per-read cost. A control
asserts an unchanged definition does *not* trigger a rebuild, which is what
stops this being written as "always rebuild on open".

⛔ **What this does NOT cover, and cannot:** `computeQueryHash` hashes `mvName` +
dependency set + `summarizeQueryPlan`, and **not `rowKey`**. A changed row key
produces an identical hash and stays invisible to drift detection — which is
exactly the "old-key rows survive beside new ones" symptom. That needs its own
decision: function identity is not reliably hashable, which is why predicates
already carry an explicit `hash` the caller bumps. `wherePredicate` bodies are
likewise still deferred (`query-hash.ts:24`, "a later sub-issue").

⚠️ Detection stops at the first row this MV stamped, since the stamp is uniform
across its rows. Worst case is a same-collection MV whose user rows all precede
its own: then the scan is the collection, once per session.
