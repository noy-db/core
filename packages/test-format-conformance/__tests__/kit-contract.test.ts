/**
 * The kit's first test of itself (core#43).
 *
 * ⛔ WHY IT DID NOT HAVE ONE, AND WHY THAT MATTERS. This package is published
 * and its whole job is asserting things about OTHER packages — and nothing
 * asserted anything about it. That is how `toSatisfy(() => true)` survived in
 * the success case: nine `as-*` fixtures went green against a check that passes
 * on anything which resolves, and no test here could notice.
 *
 * ## Why a child vitest
 *
 * `runFormatConformanceTests` registers `describe`/`it`. To assert that the kit
 * FAILS a bad fixture, its cases have to run in a process whose exit code we
 * can read — inside this one they would just fail this suite. So the fixtures
 * are named `.suite.ts` — the package collects only `.test.ts` files, so they
 * are invisible to the main run — and are executed with their own config.
 *
 * (That sentence used to name the glob literally, which closed this comment
 * early: a JSDoc block cannot contain the two characters that end it.)
 *
 * ⚠️ The pair is the point. Green alone shows the kit can pass; the control
 * shows it can FAIL. A kit that cannot fail is the thing this package exists to
 * prevent in others.
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
    const out = execFileSync(
      'npx',
      ['vitest', 'run', '--config', CONFIG, name],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
    )
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('the format conformance kit, run against a synthetic format', () => {
  it('PASSES a fixture that satisfies the contract', () => {
    const { code, out } = runSuite('green')
    expect(code, `the kit failed a conforming fixture:\n${out}`).toBe(0)
    expect(out).toMatch(/8 passed/)
  }, 120_000)

  it('⛔ FAILS a fixture with no observableVault — the control for the case above', () => {
    const { code, out } = runSuite('unobservable')
    expect(code, 'the kit passed a fixture it must refuse — a kit that cannot fail proves nothing').not.toBe(0)
    expect(out).toMatch(/must supply observableVault/)
  }, 120_000)
})
