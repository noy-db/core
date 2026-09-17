import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'test-ceremony-conformance',
    // ⚠️ BOTH globs, always. A kit's suites live in `__tests__`; an include that
    // misses them used to report a green run of nothing, because the test script
    // passed `--passWithNoTests`. That flag is GONE from all six kits (core#46,
    // 2026-09-17), so a kit that finds no tests now FAILS instead of passing.
    // ⛔ Do not add it back to buy silence — the silence is the defect.
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
