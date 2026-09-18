/**
 * #57 — **every error class hub can throw must be catchable by class.**
 *
 * This is the invariant form of a defect that has now shipped three times
 * one-at-a-time: `isConflictError` (#1224), the `debugPlaintext` cluster (#914)
 * and `FieldMetaUnknownFieldError` (#57). Each was found by a person noticing,
 * and each was closed with a test naming that one symbol — which is exactly the
 * shape this repo's `CLAUDE.md` records as the wrong remedy.
 *
 * ## What it asserts, and why that predicate
 *
 * Every `export class …Error` under `src/**` is reachable, **by runtime export**,
 * from at least one entry in the package's `exports` map.
 *
 * ⚠️ The narrower predicate — "every error thrown on a *published path*" — is the
 * one we actually care about, and it is not decidable here: it needs the call
 * graph from each entry to each `throw`. The wider one is cheap, has no
 * exclusions today (173 of 173 pass), and over-reports in only one direction:
 * it can demand an export for a class no consumer can reach. That is a far
 * cheaper failure than the one it replaces — an uncatchable error in a
 * consumer's `catch` block.
 *
 * ⛔ If a future class genuinely must stay internal, add it to `INTERNAL` with
 * the reason. Do **not** loosen the test to "some errors are exported".
 *
 * Walks the BUILT bundles, not source, for the reason `debug-subpath-reachable`
 * gives: an npm consumer resolves the exports map, and an `export *` barrel
 * names nothing textually while still carrying the binding.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Classes deliberately not on any published surface. Empty, and meant to stay that way. */
const INTERNAL = new Set<string>([])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(p)
  }
  return out
}

/** Every `export class XError` declared under `src/**`. */
function declaredErrorClasses(): string[] {
  const names = new Set<string>()
  for (const file of walk(join(HUB, 'src'))) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/^export (?:abstract )?class (\w*Error)\b/gm)) {
      if (!INTERNAL.has(m[1]!)) names.add(m[1]!)
    }
  }
  return [...names].sort()
}

const pkg = JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string } | string>
}
/** A string condition is a published data asset (`codemods/*`), not a module. */
const ENTRIES = Object.entries(pkg.exports)
  .filter((e): e is [string, { types: string; default: string }] => typeof e[1] !== 'string')
  .map(([subpath, cond]) => [subpath, join(HUB, cond.default)] as const)

describe('#57 — every error class reaches a published entry', () => {
  const built = existsSync(join(HUB, 'dist'))

  it.runIf(built)('is catchable by class from at least one subpath', async () => {
    const exported = new Set<string>()
    let loaded = 0
    for (const [, js] of ENTRIES) {
      if (!existsSync(js)) continue
      const mod = (await import(pathToFileURL(js).href)) as Record<string, unknown>
      for (const k of Object.keys(mod)) exported.add(k)
      loaded++
    }

    // Positive control. Without it a resolution failure reports every class as
    // unreachable and reads as a catastrophic regression — which is precisely
    // how the first #57 measurement went wrong.
    expect(loaded).toBeGreaterThan(20)
    expect(exported.has('NotFoundError')).toBe(true)

    const declared = declaredErrorClasses()
    expect(declared.length).toBeGreaterThan(100)
    expect(declared.filter((n) => !exported.has(n))).toEqual([])
  })
})
