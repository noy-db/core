---
"@noy-db/to-file": patch
---

to-file: the legacy-name fallback was wrong in four ways (core#198 follow-up)

`noy-db/to` found these reading core#198's code; every one reproduced at the
line before being fixed.

**(i) It could return another record's ciphertext.** `a%00b` is simultaneously a
literal id *and* the encoded form of `a\x00b`, so falling back to the raw
`a%00b.json` for the literal id handed back the NUL id's record. core#198's
changeset called this residual a cosmetic `list` artefact — it was a **cross-id
read**. The raw name is now used only when the id holds no NUL, contains a `%`,
and `encodeId(decodeId(id)) !== id` — that last condition is what closes it,
because an encoded path can only ever contain `%25` or `%00`.

**(ii) The CAS read only the encoded path**, so a legacy `%`-bearing id reported
version 0 and every versioned put against it conflicted forever: `get` saw
`_v: 3` while `put` expecting 3 was told "found 0". A record readable but
unwritable is worse than one that is neither, because nothing surfaces until a
caller tries to change it.

**(iii) `loadAll` joined the decoded id into a path.** A NUL-bearing id therefore
threw inside `loadAll`'s own `try`, which abandoned the **whole collection** — a
vault holding one NUL id and one ordinary record returned an empty snapshot, and
a sync peer reads that as every record deleted. `get` and `loadAll` now share one
reader; two readers for one on-disk layout is how they drifted.

**(iv) `delete` left the legacy copy standing**, so `list` resurfaced a deleted
record and a sync peer would re-create it. Both names are removed now, and a
**write drops the raw copy** — which makes the fallback a migration rather than a
permanent second lookup path.
