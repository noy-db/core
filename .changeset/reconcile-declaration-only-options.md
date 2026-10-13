---
"@noy-db/hub": patch
---

collections: a reconcile `vault.collection()` silently dropped `archive` and `schemaUpdate` (family#194)

The cache-hit branch threads the via-family options (`refs`, `computed`,
`fieldMeta`, `meta`, `classifiedFields`, `blobFields`) through their `_apply*`
doors, but the declaration-only options had no door at all and were dropped in
silence, so a second acquisition acted as if the collection had never been
declared.

⭐ **Tiered, following core#33** — *"a virtual entry is refused, a materialized
one attaches"*: make the paths agree, and refuse only what genuinely cannot
attach.

- **`archive` now attaches.** It is a vault-level registry entry and nothing on
  the Collection changes, so arriving second costs nothing.
- **`schemaUpdate` is refused**, with a `ValidationError` that names the option
  and the collection, says *why* it cannot attach (its gate is built once, at
  construction, alongside a drain and fence coordination), and gives both ways
  out.
- **`schema` / `persistJsonSchema` are untouched here, deliberately** — tracked
  as their own change.

⛔ **A blanket refusal was the first attempt and it is wrong.** core#33's own
test states the reason: *"MV registration opens its source collection first,
which makes the consumer's own declaration the reconcile call."* A consumer
declaring on a collection that backs a materialized view is **forced** to be
second, so refusing them breaks correct code — three in-tree tests, core#33's
among them, failed when tried. `schema` is `private readonly` on Collection
while `computed` and `moneyFields` are mutable for exactly this
MV-pre-creation reconcile; giving `schema` the same door is the follow-up.

⚠️ **Cache-state dependent, and not a defect in the check:** anything that
clears the collection cache — `_enableSync`, `_reloadKeyringAfterSync`
(family#192) — sends the next acquisition down the fresh branch, where every
option is honoured and nothing refuses. The same call can therefore succeed or
refuse depending on whether a sync happened in between.
