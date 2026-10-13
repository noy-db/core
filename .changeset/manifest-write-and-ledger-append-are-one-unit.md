---
"@noy-db/hub": patch
---

manifest: the schema-manifest write and its ledger append are now one unit (family#197)

`auditManifestWrite` records `payloadHash` for `version: expectedVersion + 1`,
and `verifyBackupIntegrity` recomputes the **latest** entry's hash against the
**current** envelope. The write and the append were two separate awaits, so a
sibling sync committing the next version in between left the ledger describing
an envelope that is no longer current — and restore reported `BACKUP_CORRUPTED`
on data nobody had tampered with.

⭐ **Two halves, and only one of them is a race:**

1. **The wrong envelope.** `auditManifestWrite` *re-read* the record and hashed
   whatever it found, then recorded that hash against *our* version. Now it
   hashes the envelope `writeSchemaManifest` just wrote, threaded back through
   `saveSchemaManifest`. This **removes** the window rather than narrowing it,
   and it holds across processes.
2. **The ordering.** Two appends landing in the opposite order to their writes
   leave the latest entry carrying a stale hash. A per-`(store, vault)` critical
   section orders them within one process.

⚠️ **Cross-process ordering is NOT closed, and cannot be from inside one
process.** Strict CAS orders the manifest *writes*; it does not order the two
*appends*. Half 1 removes the wrong-hash failure entirely, so what remains is
narrower — but a second process can still leave the latest entry describing a
superseded version. That needs a design decision, not a local lock.

⚠️ **Coverage, stated because it is uneven:** the lying-store test fails without
half 1 and is the only one of the four that can tell the two implementations
apart. Half 2 — the lock — has **no** distinguishing test: all four cases pass
without it, and a deterministic in-process interleaving of two syncs was not
built. Its value is argued from the mechanism above, not demonstrated.
