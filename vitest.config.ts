import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'test-harnesses/*/vitest.config.ts',
      // Release tooling (#913). Not a package, so turbo does not reach it —
      // the root `test:scripts` script and its CI step do.
      {
        test: {
          name: 'scripts',
          root: './scripts',
          include: ['__tests__/**/*.test.ts'],
          environment: 'node',
          // ⛔ These must run SEQUENTIALLY — see `test:scripts` in
          // package.json, which passes `--no-file-parallelism` (core#40).
          // ⚠️ Setting `fileParallelism: false` HERE does nothing: inside a
          // `projects` entry vitest ignores it, silently, and the race it is
          // meant to stop keeps happening. Measured, not assumed.
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/node_modules/**', 'test-harnesses/**'],
    },
  },
})
