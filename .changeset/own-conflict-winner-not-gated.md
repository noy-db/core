---
'@noy-db/hub': patch
---

**A device's own conflict winner is not judged as `sync-apply`** (core#74, pilot-1's note). After a push conflict the local record won, it was re-versioned past the remote and written back locally through `applyRemote` — and the admission gate ran on the device's OWN write with `origin: 'sync-apply'`. It passed the writer's gate when it was written; it is not an arrival. Skipped now; a merged or remote winner is still judged.
