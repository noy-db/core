# @noy-db/exclave-plain

The plaintext capsule for noy-db. Typed collections, schema and `via` fields, the query DSL and most services — with **no encryption at all**.

> ## ⛔ Read this before installing
>
> **This capsule turns off encryption.** Rows are stored as readable data, and noy-db stops being zero-knowledge. Anyone who can read your table can read your records.
>
> That is the point, not a limitation. It exists for one shape of application: a table whose rows are read **and written** by other tools, where access control already lives somewhere else — IAM, a VPC, a database grant. Installing this capsule **moves the security boundary out of noy-db and into your store.**
>
> If you are not deliberately making that trade, use the default. `@noy-db/hub` ships `enclave-aes` and needs no configuration.

## Install and bind

```bash
npm install @noy-db/hub @noy-db/exclave-plain
```

Binding happens at **build time**, through a resolution condition — never at runtime:

```js
// vite.config.js  (esbuild/webpack take the same shape)
export default { resolve: { conditions: ['noy-db:exclave-plain'] } }
```

```bash
# plain Node
node --conditions=noy-db:exclave-plain app.js
```

### ⚠️ It must be resolvable *from hub*, not just from your app

Measured, not assumed. hub's `imports` map resolves `@noy-db/exclave-plain`
**relative to hub's own package directory**, so a layout that puts it only in
your app's `node_modules` fails at import time:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@noy-db/exclave-plain'
  imported from .../node_modules/@noy-db/hub/package.json
```

With npm's flat `node_modules` this is automatic. With **pnpm's isolated
layout it is not** — hoist it so hub can see it:

```
# .npmrc
public-hoist-pattern[]=@noy-db/exclave-plain
```

The failure is loud and immediate rather than silent, which is the one good
thing about it: you cannot accidentally ship a build that *thinks* it is
plaintext and is not, or vice versa.

There is no `createNoydb({ capsule })` option, deliberately. A runtime switch is a hot-swap surface; a build condition lives in build config, and `npm ls` tells an auditor which capsule a build actually contains.

## What the `_mac` stamp does — and does not

Every body carries an integrity stamp: a SHA-256 over the record's identity (collection, id, version, tier, author) and the body bytes.

| | |
|---|---|
| ✅ | a row corrupted in transit or at rest fails to read |
| ✅ | a row written by another tool that does not know the format is identifiable as a **foreign write** |
| ✅ | a row **moved** to another collection or id, re-tiered, or re-authored no longer matches its stamp |
| ⛔ | it is **not** a defence against a malicious store |

There is no secret in exclave mode — that is what *"no unlock, IAM is the authority"* means — so **anyone who can write a row can also compute a valid stamp for it.** An attacker who controls the store can forge whatever they like.

With `enclave-aes` the equivalent property is real: the identity is bound into AES-GCM under a key the store has never seen, so a hostile store cannot produce a body that opens. Here it is a checksum with a domain separator. `__tests__/adversarial.test.ts` measures exactly this — every case that still holds, and one case, marked ⛔, that does not.

## What is unavailable, and why

Each of these refuses at `createNoydb()` with a `CapsuleNotSupportedError` naming the group and the package that asked for it — never on first write, never as a confusing decrypt failure.

| Capability | Status | Why |
|---|---|---|
| `cipher`, `digest`, `sign`, `codec` | **supported** | the body passes through; hashes and Ed25519 are identical for every capsule |
| unlock / secrets (`authenticate`) | refused | there is no secret; unlock always succeeds and your store's access control is the authority |
| key wrapping, DEK export/import (`seal`) | refused | there are no keys to wrap |
| per-record keys | refused | part of `seal` |
| sealed fields (`sealing`) | refused | per-field keys need a key |
| blind equality search (`deterministic`) | refused | equality search needs a key the store must not have |
| classified / digest-only fields (`classify`) | refused | needs a key ceremony |
| team custody, `at-*` sealing providers, `on-*` unlock | unavailable | all build on `authenticate` or `seal` |

Ask the capsule directly rather than guessing:

```ts
import { capabilities } from '@noy-db/exclave-plain'
capabilities().has('seal')   // false
```

## How much of this package is actually a cipher

Six functions. Everything else is hub's own envelope machinery — bound to those six through `makeCapsule()` from `@noy-db/hub/capsule` — or a typed refusal.

That ratio is the seam working as intended: a capsule is a cipher, not a re-implementation of the database. It also means the envelope format has exactly one definition, so this capsule and `enclave-aes` cannot drift into writing rows the other cannot read.

## Conformance

This package runs `@noy-db/test-capsule-conformance`, the same suite `enclave-aes` runs. The kit asserts the **prefix rule from the package name**: an `exclave-*` must refuse `authenticate` and `seal`, and an `enclave-*` must support them. That is what makes the prefix a trust posture rather than a naming convention.

## License

Apache-2.0
