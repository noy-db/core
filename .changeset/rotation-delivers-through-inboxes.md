---
'@noy-db/hub': minor
---

**A revoke (or rotation) keeps every other member working** (core#100, from pilot-1's shared-collection run).

Before: a rotation could re-wrap the re-minted DEK only for the caller, so every other member's file DROPPED the rotated collections (`needsRegrant`) — and `revoke` rotated everything the revoked member held, including `_users` and `_broker_member`, so each survivor lost its data keys, its directory key and its cloud identity on every revoke. Worse, the rotation's rewrites went through the raw store, invisible to the sync dirty log: a replica kept the OLD ciphertext until each record was edited again — a revoked member with store access read on, and a survivor handed the current key read `TamperedError`.

Now:
- **Rotation delivers.** The re-minted DEK for every rotated collection a member held (or had pending) is sealed to their inbox (core#96) as a new box; they drain it at their next tier-1 open or next pull. `needsRegrant` names only members whose keyring predates inboxes.
- **`_broker_member` is never rotated** — it is one record per member under that member's own key; `rotateKeys` refuses it and `_inbox_key` by name, `revoke` strips them at source. Survivors keep their cloud identity.
- **Rewrites reach the replica.** `RotateResult.rewritten` names every re-encrypted record; the kernel enters them in every sync engine's dirty log as `rekey` entries — same `_v`, new bytes, pushed with a CAS at the current version. And a pull adopts a same-version record whose bytes changed while the local copy has no pending write (a corrupted local copy is repaired by an ordinary pull now too). The sync engine's merge authority reads the CURRENT keyring, so an in-session reload (core#82) is seen by verification.
- **The inbox is a list of boxes.** Each delivery appends one (`updateUser`, a rotation, a revoke); a caller never re-seals what it cannot open; the drain opens them in order and a later box wins a slot. `KeyringFile.inbox` is `KeyringInboxBox[]` now (`@dev`-only shape, two days old).
