---
"@noy-db/hub": minor
"@noy-db/ports": minor
"@noy-db/to-file": minor
"@noy-db/to-browser-idb": minor
---

**The store contract now settles two questions it used to leave to the implementation**, and both are asserted by `@noy-db/ports/to`. Adapter authors outside this repo should expect new conformance failures until they adopt them.

**`put` — an absent record is at version 0.** `expectedVersion: 0` against an absent id still creates (unchanged, and still the race-safe way to write "only if absent"), but `expectedVersion: N > 0` against an absent id now throws `ConflictError` carrying `version: 0` instead of silently upserting. The old behaviour came from guarding the comparison with `&& existing`, so a writer saying "I expect version 5" against nothing created version 5's replacement and reported success. Implement it as `(existing?._v ?? 0) !== expectedVersion`.

**`saveAll` replaces, it does not merge.** Every non-underscore collection the snapshot omits is removed, and a collection present with an empty record set is emptied. `saveAll` is the restore half of `loadAll`, and a merging restore cannot express "this collection is gone" — omitting a key and passing `{}` would mean the same thing, so a backup would resurrect records the snapshot was taken to exclude. Reserved (`_`-prefixed) collections are asymmetric on purpose: never removed, so a partial snapshot cannot strand `_keyring`, but overwritten when the snapshot carries one. ⚠️ That means a `saveAll` payload can replace a live keyring without passing through any keyring code path — treat one as exactly as trusted as the vault itself.

**Order matters on a filesystem.** `to-file` writes the snapshot and prunes afterwards, so a torn `saveAll` leaves stale extra records rather than a hole; `to-browser-idb` does both inside one readwrite transaction. The kit asserts the outcome, not the mechanism.

**Sync behaviour change: a push to a target that holds nothing now completes as a create.** Previously, when a push's CAS was refused and the target held no record, the engine took no branch at all — the entry stayed dirty and conflicted on every later push, forever. Reachable whenever a target lost a record the local still has above `_v 1`: a `replaceRemote` restore, or a push aimed at a fresh target. The CAS refusal is new here (an absent id is now version 0, so the nonzero expectation conflicts where it used to upsert), and the stuck entry was the state it exposed. Edits parked by a restore never reach that path, so nothing a restore removed is resurrected.
