---
'@noy-db/hub': minor
---

**A restore becomes the truth on the target and on every device — `db.replaceRemote(vault)` and the restore epoch** (core#72, core#71; pilot-1's restore run is the acceptance test).

Before: `vault.load(pod)` left the sync state untouched; `push({ full })` was CAS-refused for every pod record; nothing the pod lacked was removed on the target; every device — the restorer included — converged back to the live state on its next pull. A restore under a sync peer was a local view the next sync undid.

Now:
- **`vault.load()` is sync-aware** (core#71): every engine attached to the vault is reset — dirty log, watermarks, adopted epoch. A restore is a new base; `push()` afterwards pushes nothing stale.
- **`db.replaceRemote(vault)`** makes the local vault authoritative on its primary target: every local record is written unconditionally, re-sealed above the target's version where the target moved on (so every peer's copy is superseded); every id the target holds that the local vault lacks gets a delete marker (so every peer removes it — a delete made after the pod is undone, deliberately and visibly); the reserved collections are mirrored; a new epoch is written at `_sync/epoch`. Returns `{ epoch, replaced, tombstoned, reserved }`; emits `sync:replace`.
- **Epoch-aware pull.** Every pull reads the target's epoch first. A newer epoch than the one this device adopted means the target was replaced: every unpushed local edit is parked under `_sync_rejected` (reason `restore-epoch`, listed by `db.rejected(vault)`, `readmit` keeps it locally, then put again to push), the dirty log is dropped, the epoch adopted, and the pull adopts the target wholesale. `PullResult` carries `epoch` and `resynced: true`; `sync:epoch { from, to, parked }` fires; `syncTargetStatus()` shows `epoch`.

A record's `_v` is no longer monotonic across a restore from a peer's point of view — the restorer lifts versions above the target's — which is what the epoch is for. Known limit, filed: with history on, restoring an OLDER pod over a store whose ledger moved on is refused by the integrity check (#111).
