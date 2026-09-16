# @noy-db/test-capsule-conformance

## 0.8.0

Initial release. The **contract suite every noy-db capsule must pass** — parameterized vitest tests that make *"implements the capsule contract"* a checkable claim rather than a sentence in a README.

A capsule is noy-db's crypto interior behind one seam. `enclave-aes` ships inside `@noy-db/hub`; alternatives such as `@noy-db/exclave-plain` and `@noy-db/enclave-pqc` are separate packages bound at build time through hub's `imports` map. One definition of the contract, consumed by every implementation in and out of tree — the same shape `@noy-db/test-adapter-conformance` gives the store contract.

Takes `@noy-db/hub` and `vitest` as peers.

Apache-2.0 from this, its first published version.
