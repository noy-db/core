---
"@noy-db/ports": patch
---

capsule kit: `capabilities()` is checked against behaviour, for the capsule that actually refuses (family#172)

`runCapsuleConformance` never called `assertGroupRefuses`. Only
`runEnclaveConformance` did — and `exclave-plain` does not run that suite. So
the per-group guarantee was exercised exclusively against the reference capsule,
which refuses nothing, and never against the only shipped capsule that refuses
anything. Both suites were green and the guarantee was untested where it matters.

`runCapsuleConformance` now asserts, for each of the four optional groups, that
a declared group has no function refusing with a not-supported code and an
undeclared group has every function refusing. A MIXED group fails whichever way
it declares, because a consumer cannot tell "unsupported" from "broken".

New exports: `groupVerdict`, `groupMemberNames`, `OPTIONAL_GROUPS`. The verdict
is a pure function over a refusal count, deliberately: the two FAILING shapes
are unreachable from either real capsule's run, so separating the decision from
the measurement is what makes a false control possible at all — and a control
that cannot fail is not a control.

`CapsuleUnderTest` now requires the optional-group functions, derived from
`EnclaveModule` with `Pick` rather than hand-copied. The contract always said
every symbol must exist and the optional groups may refuse; a capsule omitting
one outright was never conformant and this suite had no way to say so.

**The kit's published `CapsuleGroup` was missing `per-record-keys`** — a fourth
copy of one set of names, and the one core#42's drift check never looked at,
because it checks `ConformanceGroup`. So a capsule author importing
`CapsuleGroup` from `@noy-db/ports/capsule` got a union that could not name the
group `wrapCek`/`unwrapCek` live in. The drift check now runs **both
directions** over it: "every member is real" passes happily for a union that is
missing a member, which is exactly how this one survived.
