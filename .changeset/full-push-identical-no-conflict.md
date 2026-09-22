---
'@noy-db/hub': patch
---

**`push({ full: true })` no longer reports a record the target already holds as a conflict** (core#71, pilot-1's restore run). A full push marks every local record dirty at its current version, so the CAS refused each one the target already had at that version — ten conflicts at `localVersion: 1 / remoteVersion: 1` with byte-identical envelopes after a restore of a pod the target matched. Same version, same body → already there: completed, not counted, not reported.
