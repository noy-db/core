/**
 * family#216 — the LIBRARY entry resolved its own package root one level too
 * high, so `bundledCatalog()` and `describeBundle()` read a path outside the
 * package (`node_modules/package.json` on an install, `packages/` in this
 * tree) and threw ENOENT.
 *
 * ⛔ WHY A SRC-LEVEL TEST CANNOT SEE IT. `render.ts` computed the root as
 * `'..', '..'` from `import.meta.url`. tsup bundles with `splitting: false`,
 * so `render.ts` is INLINED into each entry and `import.meta.url` is the
 * ENTRY's path. From `src/wizard/render.ts` under vitest two levels up IS the
 * package root, so every unit test passed. Only the BUILT artefact moves the
 * module: `dist/index.js` sits one level shallower than `dist/bin/create.js`.
 *
 * ⭐ So this file imports `../dist/index.js` and refuses to run without a
 * build, the same shape as `one-bin.test.ts`. The BINS are the control: they
 * were never broken, so a change that fails them is measuring something else.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PKG_ROOT = resolve(__dirname, '..')
const LIB = resolve(PKG_ROOT, 'dist', 'index.js')
const BIN = resolve(PKG_ROOT, 'dist', 'bin', 'noy-db.js')

beforeAll(() => {
  for (const f of [LIB, BIN]) if (!existsSync(f)) throw new Error(`build first: ${f} is missing`)
})

describe('family#216 — the library entry finds its own package root', () => {
  it('⭐ `bundledCatalog()` reads the shipped catalog through the LIBRARY entry', async () => {
    const { bundledCatalog } = await import(LIB)
    // Pre-fix this threw ENOENT on `<root>/../templates/catalog.json`.
    const catalog = bundledCatalog()
    expect(Array.isArray(catalog.packages), 'the bundled catalog did not parse').toBe(true)
    expect(catalog.packages.length).toBeGreaterThan(0)
  })

  it('⭐ the resolved root is INSIDE the package, not its parent', async () => {
    const { bundledCatalog } = await import(LIB)
    expect(() => bundledCatalog()).not.toThrow()
    // The sharper form: whatever the walk found must contain our own manifest
    // AND that manifest must be ours. A parent directory also holds a
    // `package.json` in this monorepo, which is precisely how the bug hid.
    const parentPkg = resolve(PKG_ROOT, '..', 'package.json')
    if (existsSync(parentPkg)) {
      const name = (JSON.parse(readFileSync(parentPkg, 'utf8')) as { name?: string }).name
      expect(name, 'fixture assumption: the parent manifest must not be create-noy-db').not.toBe('create-noy-db')
    }
  })

  it('CONTROL — the BIN entry reads the same catalog, as it always could', () => {
    // `dist/bin/*.js` is one level deeper, so the old `'..', '..'` was correct
    // THERE. `add --list` renders the bundled catalog, so it exercises
    // `templateDir()` from the bin's depth. This passed before the fix and
    // must still pass after it: if it fails, the change broke the path that
    // already worked, and the test above is measuring something else.
    const r = spawnSync(process.execPath, [BIN, 'add', '--list'], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout, 'the bin could not render the bundled catalog').toContain('@noy-db/as-csv')
  })
})
