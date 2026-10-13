---
"@noy-db/ports": patch
---

to kit: ids must be case-distinct (family#177)

`@noy-db/ports/to` now requires that `put('Abc')` and `put('abc')` are two
records: both readable with their own bodies, both present in `list`, and both
present in `loadAll`.

**The bodies must differ, not just the count.** A store that collapsed the two
keys and kept one row would still return two results from a `list` that echoes
back the ids it was given, so a count-only assertion passes. Reading each back
and comparing the body is what catches the collapse.

On MySQL 8.4 the default collation is case- and accent-insensitive, so
`to-mysql`'s write to `abc` overwrote the row keyed `Abc` — one row survived,
keeping the key `Abc` while holding the ciphertext written for `abc`. Nothing in
the table shows it, and nothing in the kit asked.

⚠️ **It is not only MySQL.** A case-insensitive *filesystem* collapses the same
pair, so `@noy-db/to-file` fails this case on macOS (APFS default) and Windows
(NTFS default) — reproduced outside noy-db entirely with two `printf`s, which is
what shows it is the substrate rather than the adapter. Same shape as the
collation defect: the survivor keeps the first id's name and the second id's
content.

⭐ The vault side can detect it: `recordAadFor` binds the id into the AAD, so
reading `Abc` after such an overwrite fails its auth tag and surfaces as a
`TamperedError` rather than as wrong plaintext — but only for a record with a
sealed body, since a tombstone, a delete marker and a plaintext collection are
vacuously authentic.
