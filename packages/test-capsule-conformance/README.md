# @noy-db/test-capsule-conformance

The contract suite every noy-db **capsule** must pass.

A capsule is noy-db's crypto interior behind one seam. `enclave-aes` ships inside `@noy-db/hub`; alternatives such as `@noy-db/exclave-plain` and `@noy-db/enclave-pqc` are separate packages, bound at build time through hub's `imports` map. This package is what makes *"implements the capsule contract"* a checkable claim rather than a sentence in a README.

## Usage

```ts
import { runCapsuleConformance } from '@noy-db/test-capsule-conformance'
import * as capsule from './my-capsule.js'

runCapsuleConformance(capsule, { name: '@noy-db/exclave-plain' })
```

`name` is the capsule's package name, and it is **load-bearing** — see below.

## What it asserts

| group | assertion |
|---|---|
| prefix | an `enclave-*` supports `authenticate` and `seal`; an `exclave-*` refuses both |
| capabilities | `cipher`, `digest` and `codec` are declared by every capsule; the declared set refuses mutation |
| cipher | round-trips, then refuses a tampered body |
| cipher | binds AAD — the same body refuses to open under a different one |
| digest | stable for stable input, different for different input |
| sign | verifies its own signature, rejects a tampered message, fails closed on garbage |
| authenticate + seal | wrap/unwrap under a derived KEK, and refusal under the wrong secret |

## Two properties worth knowing before you change anything here

**Every negative case is preceded by its positive.** A capsule whose `decrypt` always threw would pass every tamper assertion vacuously. A conformance suite that a broken implementation satisfies is worse than no suite: it launders breakage as compliance. This mirrors hub's `adversarial-store-identity.test.ts`, which proves the untampered record reads back before asserting any tamper is refused.

**The prefix is a trust posture, not a naming convention.** `enclave-` means the capsule holds secrets; `exclave-` means data lives outside the boundary by design — no secret to authenticate, no key hierarchy to seal with. The suite reads the prefix from `name` and asserts the capability set matches it, so a capsule cannot claim a posture its capabilities contradict. `npm ls` then tells an auditor whether a given build is plaintext-at-rest.

**Integrity is not optional, including for an exclave.** A capsule that stores plaintext still MACs `(header, aad, canonical body)`. Without that, record identity and collection binding stop meaning anything and hub's adversarial-store suite passes vacuously.
