---
'@noy-db/hub': minor
---

**`compact({ reclaimLegacyBlobs })` now names the blobs it reclaimed** (#28) — `unreferencedLegacyBlobs.reclaimedETags`, alongside the existing counts. Empty on a `dryRun`, because a dry run deletes nothing. This is what lets a caller verify that the chunks a record delete deferred were actually reclaimed, rather than trusting a count.

**`ForgetResult.blobResidueETags`** — the eTags of blob content an erasure could not crypto-shred.

⛔ **Its meaning is not the obvious one, and the obvious reading is wrong in a way that matters.** On a legacy blob (no per-blob `_cek`) `forget()` *does* delete the chunks and the index row — it passes `reclaimLegacy: true`. What it cannot do is make them cryptographically unreadable, because there is no per-blob key to destroy. So the live store is clean, and the exposure being reported is that a **backup or replica taken before the erasure stays decryptable under the retained collection DEK**. A non-empty value means "treat this subject's data as erased from the live vault but potentially present in backups", not "bytes are still sitting here".

⚠️ Consequently `blobResidueETags` **cannot** be intersected with `reclaimedETags`: the sweep reclaims refCount-0 legacy index rows that still exist, and these no longer do, so the intersection is empty by construction and means nothing. The reclaim path belongs to ordinary `collection.delete()`, which passes `reclaimLegacy: false` and genuinely defers. Both behaviours are now pinned by tests, after a first draft of this change shipped the opposite claim in a doc example.

**`ForgetResult.blobResidueRecords`'s doc is corrected** in the same way — "could not be shredded" never meant the bytes remained in the live store.

**Internal:** `BlobSet.shredAllForRecord` gains `residueETags`, separating the eTag half of `residue` from the `collection:id:slot` half. The two mean different things — "the content survived" versus "the slot row was undecodable" — joined to different things, and shared one list with no discriminator.
