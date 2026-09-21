---
'@noy-db/hub': minor
---

**A `sync-peer` target is now a full replica: the roster travels with the records** (core#75).

Measured before this: a device that lost its local store and re-opened with the same target and the same secret **minted a new owner keyring** and every pulled envelope was unreadable; a user granted on the owner's device **could not open the vault on their own device at all** — the grant was a file in the owner's local store, replicated nowhere. Two cases, both on the issue, both now tests (`__tests__/keyring-replication.test.ts`).

What changed, all ciphertext moves — `with-sync` stays DEK-free:

- **Push mirrors `_keyring`** to every target (every role — a backup must be restorable). **Pull mirrors it back first**, before any record. Rule in both directions: **higher `roster_epoch` wins, the absent side receives, equal is a no-op**; a file with no epoch never overwrites one that has one. A stale copy of a narrowed user's file cannot be pushed over the narrowed one.
- **`openVault` on an EMPTY local store consults the `sync-peer` first.** Own file there → open it. Other principals' files only → `NoAccessError` (no self-provisioning, the existing gate). Nothing there → genuinely new, create as before. Backups are never consulted.
- **`revoke()` propagates**: the deletion rides the dirty log to every engine as `('_keyring', userId, 'delete')`. On pull, a local file the remote lacks is deleted — unless the remote carries no keyrings at all (a target never pushed to is not evidence of revocation) or a pending local grant protects it.
- `SyncStrategy` gains `bootstrapKeyrings()`; the un-opted-in stub is a no-op.

Cost: one extra `list('_keyring')` per pull on an encrypted vault; none for `encrypt: false`. Not carried yet, by design: `_history`, `_ledger`, `_users`, `_delegations` (core#75 tracks the decision per collection). A keyring change pulled mid-session does not reload the open keyring; reopen the vault.
