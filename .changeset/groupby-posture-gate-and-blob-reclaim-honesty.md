---
'@noy-db/hub': minor
---

**`query().groupBy()` now refuses a `queryable: 'none'` field** (#29), the way `where()`, `orderBy()` and `distinct()` already did.

⛔ **This can turn working-looking code into a throw, and that is the point.** Grouping on a virtual computed field (`computed(fn, { mode: 'virtual' })`) previously keyed every row on `undefined`, folding the whole collection into one well-formed bucket — a plausible row count over a missing key, with no error anywhere. `vLannaAi/noy-db#1269` fixed the MV union-map half of this and left the query-form half standing; pilot-1 measured the remainder on `0.8.0`. If this throws for you, the aggregate it replaces was returning a wrong number.

The gate lives in the query builder rather than the MV registry, deliberately: `validateMvGroupByAtRegistration` inspects the *declarative* `spec.groupBy` only, so a query-form MV groups inside its callback where that guard cannot see it. Gating the builder covers both forms at once. A `dateTrunc` key over a virtual field is refused too — the check reads the resolved field name.

The four verbs are now pinned by one parity table (`__tests__/29-groupby-posture-parity.test.ts`) instead of a line copy-pasted into each, so a fifth verb added without the gate fails a test rather than shipping.

**`Collection.delete()` now documents what a `null` blob read does and does not prove** (#28). Releasing a record's blob slots is unconditional, but reclamation is not: a `perRecordKeys` collection crypto-shreds at refCount 0, while a legacy shared-DEK collection retains the chunks until `vault.compact({ reclaimLegacyBlobs: true })`. Both give the caller the same `null` from `blob(id).get(slot)`, so the null is not evidence of erasure on a legacy collection — which is how a consumer came to read a deferred GC as a broken cascade. No behaviour changed; the deferral is the documented #1453 posture. What changed is that it is now stated on the verb people call, and the seam between "record deleted" and "chunks reclaimed" is covered by a test — previously #1451 stopped at the null read and #1453 only exercised reclaim after an overwrite.
