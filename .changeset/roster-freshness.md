---
'@noy-db/hub': patch
---

**Roster freshness — two findings from pilot-1's direct-cloud run of core#96, fixed.**

- **An open session now drains an inbox delivery at its next pull.** The in-session roster reload (core#82) re-derived the KEK from the secret the vault was opened with; after an in-session `rotateSecret` that secret is stale, so the reload failed into `PullResult.errors` and a box delivered by `updateUser` sat undrained until a reopen (and a file drained by another device was never adopted). The reload uses the KEK the session holds — also skipping 600K PBKDF2 iterations. A file re-keyed under the session by someone else (a peer recovery) reports `InvalidKeyError` in `errors`: a defined event. `LoadKeyringOptions` accepts `kek` as an alternative to `secret`.
- **An authority edit on a stale copy is never silently lost.** `grant`, `updateUser`, `revoke` and `recoverUser` first refresh the member's keyring file from every sync target that supersedes the local copy (one GET per target; an unreachable target fails the edit rather than letting it push as the loser). And a push that discards a local `_keyring` the epoch rule did not write — the remote ahead, or diverged at the same epoch — reports it in `conflicts` (collection `_keyring`).
- **`reserved` on `PushResult` / `PullResult`**: reserved-collection records mirrored by the run (keyrings, users, broker seeds), which never count in `pushed` / `pulled`. Present when non-zero.
