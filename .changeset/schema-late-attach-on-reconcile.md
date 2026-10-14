---
"@noy-db/hub": patch
---

**A `schema` declared on a second `vault.collection()` call is now applied
instead of being dropped (family#208).** Previously the collection validated
**nothing**: a `put` of a record the schema rejects was accepted.

This is not an exotic path. Materialized-view registration opens a source
collection during `openVault`, before the consumer declares it — so a consumer
declaring `{ schema }` on an MV-backed collection is *forced* to be second, and
that call was the one being dropped. `computed` and `moneyFields` were made
mutable for exactly this ordering; `schema` never got the same door.

`schema` now attaches **first-wins**, matching every other late-attach door.
First-wins rather than last-wins deliberately: the collection may already hold
records admitted under the schema it was constructed with, so replacing it
would re-contract data already stored.

⚠️ `persistJsonSchema` is unchanged, and measuring it showed it needs no door:
the persist path runs only when `persistJsonSchema`, `schema` **and** a
non-empty `schemaUpdate` are all present. `schemaUpdate` cannot attach on a
second acquisition (its gate is built once, at construction — family#194), and
`persistJsonSchema` is equally inert without it on the *first* acquisition, so
this was never a reconcile-specific drop.
