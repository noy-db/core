---
'@noy-db/hub': minor
---

**The direct cloud shape works on the member's own device** — five gaps pilot-1 measured against real DynamoDB + STS (core#67), closed (core#90, #91, #92, #93, #94).

- **Broker seeds replicate** (core#91): `_broker/<brokerId>` and `_broker_member/<userId>` join the declared reserved set. A member on a fresh device pulls and mints; an admin on a fresh device mints without enrolling again. Revocation propagates (dirty log). The pull-side deletion guard now asks "has this target ever been pushed to?" of the ROSTER (a pushed target always carries the owner's keyring), so a reserved collection that legitimately empties by revocation propagates instead of being mistaken for a never-pushed target.
- **`revoke()` deletes `_users/<id>`** (core#94) and pushes the deletion; the replicated directory matches the roster.
- **`push({ full: true })`** (core#92): mark every record in the local store dirty at its current version, then push — records written before a target existed, or loaded from a pod, are sent. CAS still applies per record.
- **`push({ concurrency })`** (core#93, the engine half): a bounded pool of in-flight puts, each with its own CAS and conflict path; default `1` is the previous serial loop byte-for-byte. Batching inside an adapter (`BatchWriteItem`) is the adapter's, tracked in `noy-db/to`.
- **`db.attachSyncTarget(vault, target)`** (core#90): a target after open — primary when the vault had none, else keyed by position, same wiring as a declared one (moved to `kernel/sync-wiring.ts` so open and attach cannot drift), conflict resolvers registered before the attach replayed. `Vault.onDirty` is now always wired, so writes after an attach are tracked. Ends the two-phase open the direct shape needed.
- A corrupted `_data` that is not even base64 reads as `DecryptionError`, never a raw `DOMException`.

Not addressed here, stated: a pre-open credential path for a fresh device (the target must be read before `vault.broker()` exists) still needs a bootstrap credential handed in — the invite/join payload is where it belongs (`noy-db/on`); an adapter's provider memoisation is the adapter's.
