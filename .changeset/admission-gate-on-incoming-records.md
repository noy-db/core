---
'@noy-db/hub': minor
---

**An admission gate on incoming records, and per-record visibility of what a pull did** (core#74, from pilot-1's concurrent-writers probe).

Before: a record arriving by sync went through `applyRemote` as a raw store write — no guard, no closed-period rule, no `db.onBeforeWrite` hook ran on it. An offline write into a period closed elsewhere landed on every device with zero evaluations. And a pull was a count: a same-id concurrent edit resolved to the last pusher and the first writer's record was replaced with nothing to tell it.

Now:
- **Admission.** The vault lends the engine an `AdmissionAuthority` (the same shape as `MergeAuthority`): before an incoming record is written, the collection's `beforePut` gate bus (guards, periods) and the `db.onBeforeWrite` hooks run on the DECRYPTED record against this device's state, with `origin: 'sync-apply'` on the event (`GatePutEvent`, `WriteEvent`, `GuardContext` — additive; a handler that only makes sense for the writer checks it, a rule about state does not need to). Not gated: erasures (delete markers, tombstones), elevated envelopes, and records this device holds no key for (it cannot judge). Schema validation does not run — the writer validated. Zero cost when nothing is registered.
- **A fate.** A refusal parks the envelope under `_sync_rejected` (local-only: never mirrored, never full-pushed) with the local copy untouched, reports it in `PullResult.rejected` (`pulled` excludes it) and emits `sync:rejected`. `db.rejected(vault)` lists the parked records, `readmit(collection, id)` applies one after all (bypassing the gate), `discard(collection, id)` drops the parking record. A refusal is per device.
- **`PullResult.applied[]`** — every record the pull applied, with `replaced: { version, by }` when it superseded a local copy: the first writer of a same-id concurrent edit now sees that its version was replaced, and by whom.

Deferred, filed: an arbiter device replicating its refusals so the WRITER learns (#107), and a push-side re-check against the current local state (#108).
