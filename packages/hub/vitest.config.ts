import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from '../../vitest.shared.js'

export default defineConfig({
  resolve: {
    alias: {
      // ⛔ `#capsule` MUST resolve to SOURCE when running from source.
      //
      // package.json's `imports` map points `#capsule` at `./dist/...`, which
      // is right for the PUBLISHED package and wrong here: the door would load
      // the built enclave while every other hub file imports `src`, giving two
      // copies of every class with different identities. `instanceof` then
      // fails across the door — silently, and only for consumers who cross it.
      //
      // Measured 2026-09-12: without this alias, `capsule-door.test.ts` sees
      // `_RecordCodec` (dist) where it expects `RecordCodec` (src). That test
      // asserts IDENTITY precisely so this cannot pass unnoticed.
      '#capsule': fileURLToPath(new URL('./src/capsule/enclave-aes/index.ts', import.meta.url)),
    },
  },
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: 'core',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
