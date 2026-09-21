/**
 * The suite, run against hub's reference store (core#46).
 *
 * ⛔ WHY THIS PACKAGE HAD NO TEST AT ALL, AND WHY THAT MATTERS. Its `include`
 * pointed at `src/`, where it has never had a test file, and its script passed
 * `--passWithNoTests` — so `pnpm test` printed "No test files found, exiting
 * with code 0" and the job went green. A published kit whose entire job is
 * asserting things about OTHER packages, asserting nothing about itself, and
 * shipped that way in `0.0.0-dev-20260917060654`.
 *
 * ## Why hub's store, and why that is not a cycle
 *
 * The kit peer-depends on hub, so hub consuming the kit would be a build cycle
 * (turbo catches it) — the reason `@noy-db/test-sealer-conformance` runs
 * `MemorySealer` from its own side. Nothing stops the arrow pointing the other
 * way: `memoryStore` is on hub's published surface, the kit already has hub as
 * a peer, and running the suite here keeps the dependency one-directional.
 *
 * ## Why BOTH store shapes
 *
 * `memoryStore()` is the bare six-method core; `memoryStore({ full: true })`
 * adds `tx` / `ping` / `listVaults` and declares `txAtomic`. The kit's optional
 * half skips itself when a method is absent, so the bare store alone would run
 * those cases as no-ops and report a row count that looks like coverage. The
 * pair is what makes the optional block observable.
 *
 * ⚠️ Green here proves the kit can PASS. It cannot prove the kit can FAIL —
 * that is `kit-contract.test.ts`, and neither half is worth much alone.
 */
import { memoryStore } from '@noy-db/hub'
import { runStoreConformanceTests } from '../../src/to/index.js'

runStoreConformanceTests('memoryStore() — hub reference store, bare six-method core', async () =>
  memoryStore(),
)

runStoreConformanceTests('memoryStore({ full: true }) — with the optional capability surface', async () =>
  memoryStore({ full: true }),
)
