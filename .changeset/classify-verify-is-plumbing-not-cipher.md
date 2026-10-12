---
"@noy-db/hub": patch
---

capsule: the classify verify oracle is plumbing, and two primitives were missing (family#168)

`pbkdf2VerifyDigest` and `blindedEqual` are now members of `CapsulePrimitives`
(the `classify` group), and the four classify orchestrators —
`revealSealedField`, `verifyDigestField`, `verifyTextField`, `matchGroupFields` —
moved from `capsule/enclave-aes/classify/` into `capsule/plumbing/`, where they
are bound by `makeCapsule()` like every other capsule-bound export.

They are hub's verify PROTOCOL, not anyone's cipher: the C4 timing pad, the R6
residue refusal, the `_tier > 0` non-comparability rule and the k-of-n
denominator. Living inside the reference capsule meant the call sites reached
them with a dynamic import past the enclave barrel, so a build whose `#capsule`
resolves elsewhere still ran the REFERENCE verify oracle — the capsule swap did
not reach it, and nothing failed because the engines happened to be correct for
AES. `check-architecture`'s `capsule-door-only` grandfather map, added one arc
earlier to record exactly those five sites, is now empty and deleted.

Laziness is preserved and relocated: `makeCapsule()` binds the engines through a
thunk that `import()`s the module on first call, so a consumer who never calls
`reveal`/`verify` still pays nothing for a PBKDF2 oracle.

**Seam change on `@noy-db/hub/capsule`.** An out-of-tree capsule must add two
members to its primitives object (a capsule without the `classify` group answers
both with its `CapsuleNotSupportedError` throw) and may re-export the four
orchestrators off its assembled capsule. `VDIG_ITERATIONS` is now exported from
`@noy-db/hub/capsule` — additive — because the write side needs it eagerly while
the verify engines must stay behind the lazy import.
