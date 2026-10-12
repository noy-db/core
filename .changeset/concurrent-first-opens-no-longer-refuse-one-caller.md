---
"@noy-db/hub": patch
---

keyring: two concurrent first opens no longer refuse one caller (family#164)

The second of two concurrent first opens got a raw `ConflictError` —
`Version conflict: expected 0, found 1` — straight out of `openVault`.
`writeKeyringFile` CASes a create at `expectedVersion: 0` (core#134), so the
second create was correctly **refused**; nothing caught the refusal.

The loser is now a **reader**: a keyring exists for this principal, written from
the same secret, so loading it is both correct and what the caller asked for.
Retried once — a second conflict would mean a third writer, and looping against
a shared store is how a race becomes a hang.

⚠️ Measured before the fix, and worth stating precisely: the vault stayed
openable afterwards, so this was an unhandled race rather than corruption. A
caller that retried succeeded; one that did not treated the vault as unopenable.
It surfaces only under concurrency, in the code path every first boot takes.

⚠️ Residual, measured rather than assumed: on a store whose
`capabilities.casAtomic` is false the CAS is advisory, so two creates could in
principle both land and the second clobber the first — which *would* be
permanent unopenability, since the winner's collection DEKs are wrapped under a
KEK nobody holds. It could not be reproduced: the 600K-iteration KEK derivation
dominates any store's read-then-write window by orders of magnitude, so the
writes serialise in practice. Recorded because "could not reproduce" is not
"cannot happen".

A non-conflict failure from the create still propagates, with its own case:
swallowing every error would turn a real write failure into a silent load.
