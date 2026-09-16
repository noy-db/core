// A config for the CHILD runs only. `scope-assertion.test.ts` spawns vitest
// with this to execute the `*.suite.ts` files beside it and assert the kit's
// own pass/fail.
//
// ⛔ They are `.suite.ts`, not `.test.ts`, and that is load-bearing: the
// workspace collects `__tests__/**/*.test.ts`, so a `.test.ts` here would be
// picked up by the MAIN run — and `wrong-option.suite.ts` is supposed to FAIL.
// A suite that is evidence about a failure must not be able to fail the suite
// that reads it.
import { defineConfig } from 'vitest/config'
import { join } from 'node:path'

export default defineConfig({
  // ⛔ THE CACHE MUST NOT LAND IN THE PACKAGE. With `root` set here, vitest
  // writes `node_modules/.vite/...` INSIDE `__tests__/fixtures/` — which is
  // git-ignored but sits under a package's `__tests__/`, so
  // `check-architecture`'s `sources-tracked` fails, and that cascades into six
  // hub tests which assert the gate is clean at HEAD. Measured: the first run
  // of this harness did exactly that, and the failures name `via-guards-empty`,
  // nowhere near the cause.
  cacheDir: join(__dirname, '..', '..', '..', '..', 'node_modules', '.vite', 'format-kit-suites'),
  test: {
    include: ['**/*.suite.ts'],
    root: __dirname,
    passWithNoTests: false,
  },
})
