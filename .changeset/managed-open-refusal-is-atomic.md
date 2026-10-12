---
"@noy-db/hub": patch
---

A managed-mode `openVault` refused for missing strong recovery now writes nothing (family#95). It previously persisted `_meta/sealed-secret`, `_keyring/<user>` and `_meta/policy` and *then* threw `ManagedRecoveryNotEnrolledError`, leaving a managed vault on disk in the one state managed mode exists to forbid — a sealed secret and a keyring with no strong recovery. The leftover was recoverable, so this is a correctness fix rather than a repair path: nothing needs migrating.

The check moved from `bootstrapPolicy`'s `assertRecoveryEnrolled` to immediately after the keyring access pre-gate, which is the only point that satisfies all three constraints. Earlier than the pre-gate and a principal with **no access** learns whether someone else's vault has recovery enrolled. Later and the writes have already happened. Unconditional and the documented two-step bootstrap breaks, because `db.team.enrollRecovery` reaches the keyring through the same accessor and needs it in order to enroll the recovery that would satisfy the check. It is therefore gated on an internal `requireManagedRecovery` flag that only `openVault` passes; the other eleven callers of that accessor are unchanged.
