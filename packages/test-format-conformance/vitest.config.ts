import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'test-format-conformance',
    // ⚠️ `__tests__` must be here, and its absence is why this kit shipped with
    // NO TESTS AT ALL. The include pointed at `src/`, where this package has
    // never had a test file, and the script passes `--passWithNoTests` — so
    // `pnpm test` printed "No test files found, exiting with code 0" and went
    // green. A published kit whose whole job is asserting things about other
    // packages, asserting nothing about itself, reporting success.
    //
    // ⛔ The counter-argument was already written down — in
    // test-capsule-conformance's config, measured 2026-09-12, in almost these
    // words. It was not applied to its five siblings. Census 2026-09-16:
    // adapter, ceremony and mesh still point at `src/` with zero tests there.
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
