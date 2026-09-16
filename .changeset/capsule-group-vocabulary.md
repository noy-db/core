---
'@noy-db/hub': minor
'@noy-db/test-capsule-conformance': minor
---

**One capsule-group vocabulary. Three disagreed, and the disagreement was invisible because nothing compiled the copies against each other** (core#42).

⚠️ **Two published changes, named here because a consumer cannot get them from a compiler.**

**1. `EnclaveNotSupportedError.group` is widened to `CapsuleGroup`.** It was `'sealing' | 'deterministic' | 'per-record-keys'` — three of ten, and **not a subset**: it could not name `classify`, which the capsule contract explicitly documents a capsule refusing, nor the six core groups. **If you `switch` exhaustively on `err.group`, you now have more cases to handle.** The narrowness was invisible because hub *never constructs this error* — it exists for a fork to throw, so that union is a contract for third-party capsule authors, and hub's own test only ever built it with `'sealing'`.

**2. `capabilities()` now reports one more group.** `CapsuleGroup` gains `per-record-keys`, and the reference capsule advertises it. `wrapCek` / `unwrapCek` are real primitives a capsule may refuse independently, with a live refusal test in the conformance kit since it shipped — but no group covered them, so the refusal could not be *named*. The reference capsule was under-reporting itself; *"supports every group"* had been untrue in its own docstring. **If you inspect `capabilities()`, expect ten members, not nine.**

**`@noy-db/test-capsule-conformance`:** `writeEnvelopeBody`'s identity parameter gains the required `version`, and its optional fields gain `| undefined` to match hub's `RecordIdentity` exactly. Both were narrower than reality, so a capsule author implementing the declared shape wrote a handler that did not know `version` arrives and that **rejects an identity hub can actually pass** (`{ tier: undefined }` is legal under `exactOptionalPropertyTypes`, and the kit's `tier?: number` refused it).

### Why all of this shipped undetected

The kit declares `EnclaveModule` **structurally rather than importing hub's type**, deliberately and for a good reason: a fork's capsule is a different object, shape-checked, never required to be hub's own module. What was missing is anything checking that the copy still matched. It had drifted **four times**, and the second, third and fourth were each found while fixing the one before.

`__tests__/contract-drift.test.ts` now compiles the structural copy against hub's real types, and `tsconfig.tests.json` is what makes those assertions load-bearing — they fail by not compiling, so without the config they are inert text.

⚠️ **The config carries a finding of its own.** Compiling the kit's tests needs `#capsule` mapped to hub's source, because hub's `imports` map points `#capsule` at `./dist/`, so hub's own *source* reaches for hub's *build output*. Measured: 398 errors without it, 10 with only the package specifier mapped, 6 once `#capsule` is mapped too — and those 6 were the real drift.
