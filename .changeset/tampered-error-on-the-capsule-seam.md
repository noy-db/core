---
"@noy-db/hub": minor
---

`TamperedError` is now exported from `@noy-db/hub/capsule`, additively — it was already on the root barrel and stays there.

A capsule author binding `/capsule` could not catch, or construct, the error their own capsule is expected to throw: `classify/vdig.ts` raises `TamperedError` on any AAD or auth-tag mismatch and the record codec converts a subtle `OperationError` into one, so it is part of the contract a capsule implements — but it shipped only on hub's root barrel, which a capsule package must not import, that being the point of binding a narrow seam. The two workarounds were both wrong: re-declare the class, giving two constructors whose `instanceof` is false across the door, or throw something hub does not recognise.

Only the base error. `KeyringTamperedError` is raised by the keyring, which is kernel code on hub's side of the seam — a capsule never throws it.
