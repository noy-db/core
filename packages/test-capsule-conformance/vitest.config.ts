import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'test-capsule-conformance',
    // ⚠️ `__tests__` must be here. The suites that run the REFERENCE capsule
    // through this kit live there, and with `--passWithNoTests` in the test
    // script an include that misses them reports a green run of nothing.
    // Measured 2026-09-12: "No test files found, exiting with code 0".
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
