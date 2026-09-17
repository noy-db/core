import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'test-format-conformance',
    // ⚠️ BOTH globs, always. A kit's suites live in `__tests__`; an include that
    // misses them used to report a green run of nothing, because the test script
    // passed `--passWithNoTests`. That flag is GONE from all six kits (core#46,
    // 2026-09-17), so a kit that finds no tests now FAILS instead of passing.
    // ⛔ Do not add it back to buy silence — the silence is the defect.
    //
    // ⭐ HISTORY, kept because it is the argument FOR the sweep: this kit once
    // shipped with NO TESTS AT ALL — include pointed at `src/`, where it has
    // never had a test file, so `pnpm test` printed "No test files found,
    // exiting with code 0" and went green. A published kit whose whole job is
    // asserting things about other packages, asserting nothing about itself.
    // The counter-argument was ALREADY WRITTEN DOWN, in
    // test-capsule-conformance's config, measured 2026-09-12, in almost these
    // words — and four days later three siblings (adapter, ceremony, mesh)
    // still pointed at `src/` with zero tests there. A counter-argument in one
    // script does not propagate; that is why this is now uniform across six.
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
