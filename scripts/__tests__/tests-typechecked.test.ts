/**
 * core#40 — `check-architecture`'s `tests-typechecked` invariant.
 *
 * Every package `tsconfig.json` was `include: ["src"]`, and vitest transpiles
 * without typechecking, so a package's test files were compiled by nothing.
 * Two real defects were sitting in the tree when the check landed: a test
 * importing `InspectorNoydb`, renamed to `InspectableContainer` some time
 * earlier, and a fake store returning `{ ids, cursor }` for `listPage` where
 * `ListPageResult` is `{ items, nextCursor }`.
 *
 * ⚠️ The check is what keeps that from silently returning. A package added
 * next month with tests and no second program would restore exactly the old
 * state, and nothing else in the repo would notice — which is the whole
 * shape of this milestone's defect class.
 *
 * Exercised against the real script and the real tree: a probe package with
 * one test file and no covering program is planted, the script is expected to
 * name it, and the probe is removed again.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = REPO_ROOT + 'scripts/check-architecture.mjs'
const PROBE_DIR = REPO_ROOT + 'packages/__tests_typechecked_probe__'

function runCheck(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

/**
 * @param typecheck - the probe's `typecheck` script, or undefined for none.
 * @param tests - whether the probe ships a test file at all.
 */
function plantProbe(typecheck: string | undefined, tests = true): void {
  mkdirSync(PROBE_DIR + '/__tests__', { recursive: true })
  writeFileSync(
    PROBE_DIR + '/package.json',
    JSON.stringify({ name: '@noy-db/__probe__', private: true, scripts: typecheck ? { typecheck } : {} }, null, 2),
  )
  writeFileSync(PROBE_DIR + '/tsconfig.json', JSON.stringify({ include: ['src'] }, null, 2))
  if (tests) writeFileSync(PROBE_DIR + '/__tests__/probe.test.ts', 'export const probe = 1\n')
}

afterEach(() => {
  // ⛔ A stranded probe makes `check:architecture` fail FOR REAL, for
  // everyone, and the failure names a package nobody can find. Same hazard
  // the via-guard suite documents, same remedy.
  if (existsSync(PROBE_DIR)) rmSync(PROBE_DIR, { recursive: true, force: true })
})

describe('check-architecture — tests-typechecked', () => {
  it('the tree as committed puts every package\'s tests in front of a compiler', () => {
    const { status, out } = runCheck()
    expect(out).not.toMatch(/tests-typechecked/)
    expect(status).toBe(0)
  })

  it('FIRES on a package with tests and no covering program', () => {
    // Without this the case above is satisfied by a check that can never
    // fail — the exact thing the check exists to prevent elsewhere.
    plantProbe('tsc --noEmit')
    const { status, out } = runCheck()
    expect(out).toMatch(/tests-typechecked/)
    expect(out).toMatch(/@noy-db\/__probe__/)
    expect(status).not.toBe(0)
  })

  it('FIRES on a package with tests and no typecheck script at all', () => {
    plantProbe(undefined)
    const { out, status } = runCheck()
    expect(out).toMatch(/no `typecheck` script/)
    expect(status).not.toBe(0)
  })

  it('ACCEPTS a package whose typecheck script runs a covering second program', () => {
    // The shape this repo actually uses. Asserting acceptance as well as
    // refusal is what stops the check from degenerating into "any package
    // with tests fails".
    plantProbe('tsc --noEmit && tsc --noEmit -p tsconfig.tests.json')
    writeFileSync(
      PROBE_DIR + '/tsconfig.tests.json',
      JSON.stringify({ include: ['src', '__tests__'], exclude: [] }, null, 2),
    )
    const { out } = runCheck()
    expect(out).not.toMatch(/@noy-db\/__probe__/)
  })

  it('FIRES on a TEST-HARNESS with tests and no typecheck script', () => {
    // ⛔ The first version of this check scanned `packages/` only and went
    // green while six harnesses and `scripts/__tests__` were compiled by
    // nothing. A guard whose green means less than it appears to is the
    // defect class this milestone is named for — so the scope itself is
    // asserted, not just the rule.
    const HARNESS = REPO_ROOT + 'test-harnesses/__probe__'
    mkdirSync(HARNESS + '/__tests__', { recursive: true })
    writeFileSync(HARNESS + '/package.json', JSON.stringify({ name: '@noy-db/__harness_probe__', private: true, scripts: {} }, null, 2))
    writeFileSync(HARNESS + '/tsconfig.json', JSON.stringify({ include: ['src'] }, null, 2))
    writeFileSync(HARNESS + '/__tests__/probe.test.ts', 'export const probe = 1\n')
    try {
      const { out, status } = runCheck()
      expect(out).toMatch(/@noy-db\/__harness_probe__/)
      expect(status).not.toBe(0)
    } finally {
      rmSync(HARNESS, { recursive: true, force: true })
    }
  })

  it('FIRES when the root manifest runs no program over scripts/__tests__', () => {
    // `scripts/` is not a workspace package, so turbo never reaches it and
    // the per-package rule cannot see it. It is checked against the ROOT
    // manifest instead — and that path needs its own proof.
    const ROOT_PKG = REPO_ROOT + 'package.json'
    const original = readFileSync(ROOT_PKG, 'utf8')
    try {
      writeFileSync(ROOT_PKG, original.replace(/\s*"typecheck:scripts":[^\n]*\n/, '\n'))
      const { out, status } = runCheck()
      expect(out).toMatch(/scripts\/__tests__ exists but the root manifest runs no program over it/)
      expect(status).not.toBe(0)
    } finally {
      writeFileSync(ROOT_PKG, original)
    }
  })

  it('IGNORES a package that has no test files', () => {
    plantProbe('tsc --noEmit', false)
    const { out } = runCheck()
    expect(out).not.toMatch(/@noy-db\/__probe__/)
  })
})
