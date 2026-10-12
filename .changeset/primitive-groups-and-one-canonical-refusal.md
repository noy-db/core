---
"@noy-db/hub": patch
"@noy-db/ports": patch
---

capsule: every primitive carries its group, and the not-supported refusal has one class (family#168)

`@noy-db/hub/capsule` gains `PRIMITIVE_GROUPS`, `GROUPS_WITHOUT_PRIMITIVES` and
`PRIMITIVES_NOT_ON_THE_DOOR`. The first is typed
`Record<keyof CapsulePrimitives, CapsuleGroup>`, so a primitive added without a
group tag is a compile error and a tag for a primitive that no longer exists is
one too — `capabilities()` can no longer drift from the implementation by the
usual route, a hand-kept list nobody re-reads.

**`EnclaveNotSupportedError` is deprecated** and removed at a later breaking cut.
`CapsuleNotSupportedError` (`@noy-db/hub/capsule`, code `CAPSULE_NOT_SUPPORTED`)
is canonical: hub throws it, and a capsule throws it for a group it refuses. Two
classes with two codes had shipped side by side — hub never threw the enclave
one, `exclave-plain` threw the capsule one, and the published conformance kit
matched only the enclave code, so a capsule refusing a group exactly as the
contract says was reported as not refusing at all. Nothing failed anywhere,
because the one capsule supporting every group never takes the branch. The kit
now accepts both codes, so a fork already throwing the deprecated class keeps
passing.

`wrapCek`/`unwrapCek` are tagged `per-record-keys`, not `seal` — the group
core#42 added expressly for them.

`authenticate`, `seal`, `digest` and `sign` have no primitives, and the
completeness check **names them as exempt rather than reporting a vacuous pass**:
the first two are posture groups asserted from the `enclave-`/`exclave-` package
name, the last two are plumbing shared verbatim. The check also states that it
reaches 15 of 18 primitives, because three are codec-internal and not on any
capsule's module surface.

`@noy-db/ports/capsule` exports `assertPrimitiveTagsCovered` and
`groupWithoutPrimitives`, and asserts the tag table against its own call table
for every capsule under test. On its first run it found a real gap:
`deriveDeterministicKey` is a `deterministic` primitive the suite never called,
so a capsule could refuse `encryptDeterministic` while that one silently worked
and the group-consistency guarantee still reported a clean refusal.
