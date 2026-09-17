// A config for the CHILD runs only. `kit-contract.test.ts` spawns vitest with
// this to execute the `*.suite.ts` files beside it and read the kit's own
// pass/fail out of an exit code.
//
// ⛔ THE CACHE MUST NOT LAND IN THE PACKAGE. With `root` set here, vitest
// writes `node_modules/.vite/...` INSIDE `__tests__/fixtures/` — git-ignored,
// but under a package's `__tests__/`, so `check-architecture`'s
// `sources-tracked` fails and the failures name something nowhere near the
// cause. Measured first in the format kit; same escape here.
import { defineConfig } from 'vitest/config'
import { join } from 'node:path'

export default defineConfig({
  cacheDir: join(__dirname, '..', '..', '..', '..', 'node_modules', '.vite', 'mesh-kit-suites'),
  test: {
    include: ['**/*.suite.ts'],
    root: __dirname,
    passWithNoTests: false,
  },
})
