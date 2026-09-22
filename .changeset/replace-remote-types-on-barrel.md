---
'@noy-db/hub': patch
---

`ReplaceRemoteResult` and `SyncEpochRecord` (core#72) are exported from the root barrel, so a consumer can name what `db.replaceRemote()` returns and what `_sync/epoch` carries.
