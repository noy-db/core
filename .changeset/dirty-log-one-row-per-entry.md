---
"@noy-db/hub": patch
---

**Fixed: every tracked write re-saved the whole sync queue, which froze large
imports (family#223).** With a sync target attached, each local write
re-serialised the entire dirty list into `_sync/meta`, so N writes before a
push cost **O(N²)** bytes. Measured: 180 KB at 50 writes, 700 KB at 100,
2.76 MB at 200 — 3.9× per doubling, extrapolating to ~276 MB at 2,000 writes.
In a browser that was 2,000 growing IndexedDB writes on the main thread, and it
froze a reported import twice.

The queue is now **one row per entry** under `_sync_dirty`. A tracked write is
one small put of constant size — measured at a flat ~218 bytes per write across
an 8× range — deduplication is the same row key overwritten, and `_sync/meta`
is not written on the write path at all, since nothing in it changes.

A second quadratic factor went with it: deduplication was an O(N) scan per
write, so N writes cost O(N²) comparisons. It is now a keyed lookup.

**An in-flight queue is migrated on load**, before any push, so records queued
by an earlier version are not dropped by the upgrade. One-way and idempotent.

⚠️ **Downgrade:** an older build reads the queue from `_sync/meta`, which this
version always writes empty, so a queue written here and then opened by an
older hub will not be pushed by it. Accepted deliberately rather than guarded —
a guard would need a version stamp hub does not write.
