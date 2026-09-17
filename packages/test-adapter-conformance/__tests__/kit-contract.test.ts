/**
 * The kit's proof that it can FAIL (core#46).
 *
 * `reference.test.ts` shows the suite passes hub's own store. That alone is
 * the weaker half of the pair: a suite of `expect(true).toBe(true)` would pass
 * it too. This file runs the kit against stores that are wrong in exactly one
 * way each and asserts it refuses them.
 *
 * ## Why a child vitest
 *
 * `runStoreConformanceTests` registers `describe`/`it`. To read whether the
 * KIT failed, its cases have to run in a process whose exit code we can see —
 * inside this one they would simply fail this suite. So the fixtures are named
 * `.suite.ts`, invisible to a run that collects only `.test.ts`, and are
 * executed with their own config.
 *
 * ⭐ EACH CONTROL ASSERTS **ONE** FAILING CASE, not just a red run. A fixture
 * broken in one way that reddens two cases would mean some other assertion is
 * also reacting, and then a green run of the reference says less than it
 * appears to. The count is the attribution.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, 'fixtures', 'vitest.suites.config.ts')
const REPO_ROOT = join(HERE, '..', '..', '..')

/** Run one child suite; return its exit code and output. */
function runSuite(name: string): { code: number; out: string } {
  try {
    const out = execFileSync('npx', ['vitest', 'run', '--config', CONFIG, name], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { code: 0, out: plain(out) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: plain(`${err.stdout ?? ''}${err.stderr ?? ''}`) }
  }
}

/**
 * Strip ANSI colour from the child's output before matching.
 *
 * ⚠️ vitest colours its SUMMARY, so `Tests  1 failed | 34 passed` carries
 * escape sequences between every word. A regex written against what the
 * terminal shows silently never matches, and an `expect(...).toMatch` that
 * cannot match is the same defect class this whole issue is about.
 */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*m/g, '')
}

/** Assert the kit refused this fixture, and refused it in exactly one case. */
function expectRefused(suite: string, because: RegExp): void {
  const { code, out } = runSuite(suite)
  expect(code, `the kit PASSED a store it must refuse:\n${out}`).not.toBe(0)
  expect(out).toMatch(because)
  expect(out, `more than one case reacted — the control no longer attributes:\n${out}`).toMatch(
    /Tests {2}1 failed \|/,
  )
}

describe('the adapter conformance kit, run against stores broken in one way each', () => {
  it('⛔ FAILS a store that accepts any expectedVersion', () => {
    expectRefused('broken-ignores-expected-version', /put with wrong expectedVersion throws ConflictError/)
  }, 120_000)

  it('⛔ FAILS a store that strips the _del delete marker (#589)', () => {
    expectRefused('broken-drops-delete-marker', /round-trips a delete-marker envelope/)
  }, 120_000)

  it('⛔ FAILS a store implementing tx() without declaring capabilities.txAtomic', () => {
    expectRefused('broken-undeclared-tx', /does not declare capabilities\.txAtomic/)
  }, 120_000)
})
