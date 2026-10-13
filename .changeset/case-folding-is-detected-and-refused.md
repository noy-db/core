---
"@noy-db/ports": patch
"@noy-db/to-file": patch
---

to: ids must be case-distinct, and a case-folding store refuses rather than collapses (family#177)

`@noy-db/ports/to` now requires that `put('Abc')` and `put('abc')` are two
records — or that the store **refuses** the second write. A refusal is
conformant, the same shape as the existing `..` traversal case: what is
forbidden is accepting both writes and silently keeping one.

On MySQL 8.4 the default collation is case- and accent-insensitive, so
`to-mysql`'s write to `abc` overwrote the row keyed `Abc` — one row survived,
keeping the key `Abc` while holding the ciphertext written for `abc`. Nothing in
the table shows it, and nothing in the kit asked.

**It was never only MySQL.** A case-insensitive *filesystem* collapses the same
pair, so `to-file` was affected on macOS (APFS default) and Windows (NTFS
default). Reproducible outside noy-db entirely: `printf 'UPPER' > Abc.json`,
`printf 'lower' > abc.json`, and one file named `Abc.json` containing `lower`.
The survivor keeps the first id's name and the second id's content.

`to-file` now detects a case-folding filesystem at open and **refuses** a write
whose id case-folds onto a different existing id, with an error naming both ids.
No on-disk format change and no migration: encoding case into the filename would
move every record whose id has an uppercase letter.

⛔ Detected by **probing the store directory**, not by checking
`process.platform`. `darwin` is the wrong question twice over — macOS can be
formatted case-sensitive, and a case-sensitive host can carry a case-folding
mount (SMB, exFAT, a Docker bind mount from a macOS host). Only the directory
the records live in can answer.

⚠️ The probe uses `mkdir` + `stat`, never a file write. Two earlier shapes both
**consumed a test's injected write failure** — `atomic-write.test.ts` tears the
first write to simulate an interruption — so the real `put` succeeded and two
cases that assert a rejection stopped seeing one. A diagnostic that spends the
caller's first write changes the thing it is diagnosing.

⚠️ If the probe cannot run (read-only directory, permissions) the adapter assumes
**not** folding. A false positive would refuse legitimate writes on a
case-sensitive store, which is worse than leaving the collapse detectable
downstream: hub's AAD binds the record id, so a folded read surfaces as
`TamperedError` rather than as wrong plaintext.
