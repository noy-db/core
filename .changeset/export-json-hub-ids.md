---
"@noy-db/hub": patch
---

**Fixed: `diffVault` against an `exportJSON()` artefact reported every record
as deleted (family#175).** Diffing a vault against its own export returned
`{ add: 0, modify: 0, delete: <every record> }` with `skipped: 0`, so nothing
indicated a problem — and applying that diff would have emptied the vault.

The artefact nests records under `collections: { <coll>: { records } }`, while
the candidate parser required the top-level value to *be* the array (the
`dump()`-style flat shape). `collections` was therefore skipped and the
candidate parsed as empty. `diffVault` now reads both artefact shapes.

**Also: `exportJSON()` carries each record's hub id**, so an exported vault can
be diffed and re-imported by id. Each collection gains `ids: string[]`, aligned
**position-for-position** with `records` — the shape `envelopeMeta` uses, and
for the same reason: a record need not carry an id *field* at all, because
hub's id is the store key rather than a property of the record. An id-less
record could not previously be matched across the two sides at all.

Additive: an artefact without `ids` still diffs by record field, and a reader
that does not know the key ignores it. Both sides of a diff key by hub id when
the candidate carries ids — keying only one side would mismatch every record
whose id field differs from its store key, which is exactly the id-less record
this fixes.
