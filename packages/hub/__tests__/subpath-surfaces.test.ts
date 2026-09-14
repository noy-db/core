/**
 * Every published subpath's VALUE surface is frozen.
 *
 * ⛔ WHY THIS EXISTS, and it is not "more coverage is nice". Hub published 55
 * subpaths and froze 11. The other 44 could gain or lose an export with
 * nothing failing — and on 2026-09-13 that turned a question into two days of
 * confident wrong answers:
 *
 *   THREE sessions independently concluded `hasSealedBody` was "not exported".
 *   One checked `index.d.ts` (does not cover a subpath export). One checked the
 *   surface goldens (do not cover an UNFROZEN subpath). One relayed a
 *   peer-floor story (covers nothing). It is exported — from
 *   `@noy-db/hub/capsule`, added by the same author who then reported it
 *   missing. The consumer found it in one import, because they were the only
 *   party who actually wanted the symbol.
 *
 * ⭐ THE DEFECT WAS NOT THAT THE GOLDENS WERE WRONG. It is that **a missing
 * golden and a clean golden read identically** at the call site where all
 * three looked. An instrument that can only say "absent" is indistinguishable
 * from one saying "verified absent", and every negative it returns is
 * unfalsifiable. Naming the credit: `on` put it in exactly those words, which
 * is what turned "add the capsule golden" into "make absence impossible".
 *
 * ⚠️ SCOPE, so this is not read as more than it is: VALUE exports only,
 * enumerated at runtime. Type-only exports do not exist at runtime and are NOT
 * covered here — the hand-written per-subpath goldens (`to-surface.golden.json`
 * and friends) parse source and cover both, for the subpaths that have them.
 * This closes the "is it exported at all" question, not the whole surface.
 *
 * To change a surface deliberately: run `node scripts/gen-subpath-surfaces.mjs`
 * and commit the diff, so the change is visible in review. Never run it to
 * make a red test green.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SURFACES = join(HERE, 'surfaces')

interface Surface {
  readonly subpath: string
  readonly entry: string
  readonly values: readonly string[]
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, { default: string }>
}
const published = Object.keys(pkg.exports)
  .filter((k) => k.startsWith('./') && !k.endsWith('.json'))
  .sort()

const goldenFiles = readdirSync(SURFACES).filter((f) => f.endsWith('.json')).sort()

describe('every published subpath has a frozen surface', () => {
  it('has exactly one golden per published subpath — no gaps, no orphans', () => {
    // This is the assertion the whole file exists for. A subpath added without
    // a golden fails HERE, loudly, instead of joining the set whose absences
    // cannot be falsified.
    const expected = published.map((s) => `${s.slice(2).replace(/\//g, '-')}.json`).sort()
    expect(goldenFiles).toEqual(expected)
  })

  it('covers all 55 — the count is stated so a silent shrink is visible', () => {
    expect(published).toHaveLength(55)
  })
})

describe('each subpath exports exactly what its golden records', () => {
  for (const file of goldenFiles) {
    const golden = JSON.parse(readFileSync(join(SURFACES, file), 'utf8')) as Surface
    it(`${golden.subpath}`, async () => {
      const mod = (await import(join(ROOT, golden.entry))) as Record<string, unknown>
      expect(Object.keys(mod).sort()).toEqual([...golden.values].sort())
    })
  }
})

describe('the instrument itself', () => {
  it('would fail on a fabricated missing export — the control', () => {
    // Without this, "all surfaces match" could pass against a comparison that
    // never ran. Proves the assertion shape rejects a real difference.
    const golden = ['a', 'b', 'c']
    const actual = ['a', 'c']
    expect(() => expect(actual.sort()).toEqual([...golden].sort())).toThrow()
  })
})
