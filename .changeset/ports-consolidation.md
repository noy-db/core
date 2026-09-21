---
'@noy-db/ports': minor
'@noy-db/test-adapter-conformance': patch
'@noy-db/test-capsule-conformance': patch
'@noy-db/test-format-conformance': patch
'@noy-db/test-ceremony-conformance': patch
'@noy-db/test-sealer-conformance': patch
'@noy-db/test-mesh-conformance': patch
---

**The six conformance kits are one package: `@noy-db/ports`, one subpath per hub port** (family root decision, 2026-09-21).

`@noy-db/ports/to`, `/as`, `/at`, `/on`, `/by`, `/capsule` — bind `@noy-db/hub/<port>`, prove it with `@noy-db/ports/<port>`. Exported function names are unchanged; only the import specifier moves. Peers are what every kit already had: `@noy-db/hub` and `vitest`.

The six `@noy-db/test-*-conformance` packages now **re-export** their `@noy-db/ports` subpath and are deprecated in favour of it; they stay published for consumers still pinning them and are removed from this repo in a later change once nothing does. Each carries one test asserting it re-exports exactly the subpath surface.

Built with six self-contained entries (`splitting: false`, as every kit shipped); `__tests__/subpaths.test.ts` resolves each subpath through the package's own `exports` map and calls the function it advertises, with a control, so a dropped entry fails rather than ships.
