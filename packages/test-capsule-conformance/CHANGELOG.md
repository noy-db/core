# @noy-db/test-capsule-conformance

## 0.9.0-pre.0

**Now a re-export of `@noy-db/ports/capsule`, and deprecated in favour of it.** The six conformance kits were consolidated into one package, `@noy-db/ports`, one subpath per hub port. **This is not a break:** every function this package exported is still exported from here, unchanged in name and signature, and the peers are the same (`@noy-db/hub`, `vitest`). New code should import `@noy-db/ports/capsule`; this name stays published so an existing pin keeps working, and it will be deprecated on npm once the family's satellites have moved.

Carried in from the last changes to this kit before the move (core#42): `writeEnvelopeBody`'s identity parameter gains the required `version`, and its optional fields gain `| undefined`, matching hub's `RecordIdentity` exactly — both were narrower than reality. `__tests__/contract-drift.test.ts` (now `@noy-db/ports/__tests__/capsule/`) compiles the kit's structural copy against hub's real types, so the copy cannot drift again unseen.

README examples import the reader's own implementation from `'./my-backend.js'`-style paths instead of `'../src/index.js'`, which named the kit's own source.

## 0.8.0

Initial release. The **contract suite every noy-db capsule must pass** — parameterized vitest tests that make *"implements the capsule contract"* a checkable claim rather than a sentence in a README.

A capsule is noy-db's crypto interior behind one seam. `enclave-aes` ships inside `@noy-db/hub`; alternatives such as `@noy-db/exclave-plain` and `@noy-db/enclave-pqc` are separate packages bound at build time through hub's `imports` map. One definition of the contract, consumed by every implementation in and out of tree — the same shape `@noy-db/test-adapter-conformance` gives the store contract.

Takes `@noy-db/hub` and `vitest` as peers.

Apache-2.0 from this, its first published version.
