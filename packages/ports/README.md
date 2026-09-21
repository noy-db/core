# @noy-db/ports

The conformance suites for every noy-db port, one subpath per port. The rule a port author holds is one sentence: **bind `@noy-db/hub/<port>`, prove it with `@noy-db/ports/<port>`.**

| subpath | proves | exports |
|---|---|---|
| `@noy-db/ports/to` | a `NoydbStore` (`@noy-db/hub/to`) | `runStoreConformanceTests` |
| `@noy-db/ports/as` | an export format (`@noy-db/hub/as`) | `runFormatConformanceTests` |
| `@noy-db/ports/at` | a sealing-key provider (`@noy-db/hub/at`) | `runSealerConformanceTests`, `runDelegatingSealerObligations` |
| `@noy-db/ports/on` | an unlock ceremony (`@noy-db/hub/on`) | `runCeremonyConformanceTests` |
| `@noy-db/ports/by` | a mesh transport (`@noy-db/hub/by`) | `runMeshConformanceTests` |
| `@noy-db/ports/capsule` | a capsule / enclave (`@noy-db/hub/capsule`) | `runCapsuleConformance`, `runEnclaveConformance` |

Every suite is parameterised over the implementation under test and runs inside your own vitest. Peers: `@noy-db/hub` and `vitest`.

```ts
import { runStoreConformanceTests } from '@noy-db/ports/to'
import { toMyBackend } from './my-backend.js'

runStoreConformanceTests('to-my-backend (mock)', async () => toMyBackend({ client: mockClient() }))
```

These suites were previously published as six `@noy-db/test-*-conformance` packages; those names now re-export from here and are deprecated in favour of it. Function names did not change — only the import specifier.

## License

Apache-2.0
