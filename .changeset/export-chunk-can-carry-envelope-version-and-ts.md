---
"@noy-db/hub": patch
---

as: an export chunk can carry each record's store version and write time (family#166)

`exportStream({ withEnvelopeMeta: true })` adds `ExportChunk.envelopeMeta` —
the store-level `_v` and `_ts` of each exported record. Additive and opt-in on
`@noy-db/hub/as` and the root barrel, so no consumer changes.

**Positionally aligned with `records`, not keyed by id.** A record need not carry
an `id` field — hub's id is the store key, not a property of the plaintext — so
a `{ [id]: meta }` map would silently drop every id-less record and mis-key any
record whose own `id` field disagrees with its store key. That is family#151's
`diffVault` defect, and this is a published type. `envelopeMeta[i]` describes
`records[i]`, and a record the caller cannot read is skipped from both.

**Opt-in because the cost is asymmetric, and both halves are measured.** An
unscoped export already holds every envelope (`resolveExportSource` does one
`loadAll`), so the metadata adds **zero** store reads. A scoped export
enumerates with `list` and deliberately never pulls the envelopes — core#45b,
where that avoidance is what makes scoping a property rather than a word — so it
costs exactly **one `get` per exported record**, and only when asked. Default
`false` keeps a scoped export's read as narrow as core#45b made it.

A null envelope reports `version: 0` rather than a gap: the record was readable
a moment earlier, so null means it was deleted mid-export, and family#147 ruled
that absence *is* version 0 at the store contract. Returning `undefined` would
break the positional alignment, which is the one property a consumer cannot
reconstruct.
