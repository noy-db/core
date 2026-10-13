---
"@noy-db/hub": patch
---

money/guards: `frozenFields` refused an unchanged re-put of a nested money field (family#201)

A read with a locale adds `<path>Formatted` / `<path>Number` virtuals.
`canonicalizeIncomingMoney` decodes with `'raw'`, which stops it *adding*
virtuals — but `decodeMoneyFields` shallow-clones, so virtuals the caller
carried in survived ingest. The gate's `existing` goes through
`canonicalizeStoredMoney`, which carries none, so `frozenFields` deep-compared
`{ amount, sku, amountFormatted, amountNumber }` against `{ amount, sku }` and
threw `FieldFrozenError` for a field nobody touched.

The commonest write there is — `put(id, await get(id, { locale }))` — was
therefore refused outright on an issued record.

⭐ This is `canonicalizeStoredMoney`'s own stated rule applied to the other
side: those boundaries carry no locale, and letting a virtual through "would
re-create a two-read-paths skew inside comparisons".

⭐ **A second defect, fixed by the same change:** the virtuals were being
**persisted**. Measured — a round-tripped read stored `amountFormatted`, and it
came back out of `locale: 'raw'`, where it goes stale and carries one client's
locale forever. Raw storage is now clean after a round-trip.

⚠️ **Nested only, which is why it shipped:** a top-level money path compares
scalar-to-scalar, so the sibling virtuals never enter the comparison. A control
pins that case as unaffected.

⚠️ A caller's own field named `<moneyPath>Formatted` is now dropped on write.
That name is already owned by the read path, which overwrites it on every
localized read, so it could never have held a value of theirs reliably.
