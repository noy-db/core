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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, 'fixtures', 'vitest.suites.config.ts')
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const exec = promisify(execFile)

/**
 * Run one child suite; return its exit code and output.
 *
 * ⛔ ASYNC, and that is load-bearing — it was `execFileSync` and CI killed the
 * job with `[vitest-worker]: Timeout calling "onTaskUpdate"` while every test
 * PASSED. A synchronous spawn blocks this worker's event loop for the whole
 * child run (22s under CI contention), so the worker cannot answer vitest's
 * RPC heartbeat and the run is torn down for being unresponsive. Awaiting keeps
 * the loop free. ⚠️ Do not "simplify" this back to the sync form: the failure
 * appears only under load, names nothing in this file, and reads as flake.
 */
async function runSuite(name: string, ...extra: readonly string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(
      'npx',
      ['vitest', 'run', '--config', CONFIG, name, ...extra],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    return { code: 0, out: plain(`${stdout}${stderr}`) }
  } catch (e) {
    // ⚠️ `code`, not `status`: the promisified form reports the child's exit
    // code on `code`, and reading only `status` would call every failure 1 —
    // true enough for `not.toBe(0)`, wrong the moment anything reads the value.
    const err = e as { code?: number; status?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? err.status ?? 1, out: plain(`${err.stdout ?? ''}${err.stderr ?? ''}`) }
  }
}

/**
 * Strip ANSI colour before matching.
 *
 * ⚠️ vitest colours its SUMMARY, so `Tests  1 failed | 9 passed` carries escape
 * sequences between the words. A regex written against what the terminal SHOWS
 * silently never matches — an assertion that cannot match is the same defect
 * class this kit exists to catch, one layer up. (Paid for in core#46.)
 */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '')
}

describe('the format conformance kit, run against a synthetic format', () => {
  it('PASSES a fixture that satisfies the contract', async () => {
    const { code, out } = await runSuite('green')
    expect(code, `the kit failed a conforming fixture:\n${out}`).toBe(0)
    expect(out).toMatch(/10 passed/)
  }, 120_000)

  it('⛔ FAILS a fixture calling with an option the package no longer reads (core#43)', async () => {
    // The defect this kit could not see: as-csv's fixture passed `collection`
    // after the rename to `collections`, and 18 tests passed either side of the
    // fix. Only the scope case may react — if the gate cases go red too, the
    // control is failing for some other reason and proves nothing about scope.
    const { code, out } = await runSuite('wrong-option')
    expect(code, `the kit passed a fixture whose export widened to everything:\n${out}`).not.toBe(0)
    expect(out).toMatch(/the SCOPED call exports EXACTLY its scope/)
    expect(out).toMatch(/Tests {2}1 failed \|/)
  }, 120_000)

  it('SAYS SO IN THE OUTPUT when a fixture declares no scope, rather than passing quietly', async () => {
    // The upgrade path for every as-* fixture written before core#43: `scope`
    // is optional, so they stay green — but the run must say the property is
    // unverified, or an unchecked scope is indistinguishable from a checked one.
    //
    // ⚠️ `--reporter=verbose` is load-bearing: the default reporter prints no
    // name for a PASSING test, so the string this case looks for would never
    // appear and the assertion could not fail for the right reason.
    const { code, out } = await runSuite('no-scope', '--reporter=verbose')
    expect(code, `a fixture without \`scope\` must still pass:\n${out}`).toBe(0)
    expect(out).toMatch(/scope: SKIPPED — fixture declares no scoped call/)
  }, 120_000)

  it('⛔ FAILS a fixture with no observableVault — the control for the case above', async () => {
    const { code, out } = await runSuite('unobservable')
    expect(code, 'the kit passed a fixture it must refuse — a kit that cannot fail proves nothing').not.toBe(0)
    expect(out).toMatch(/must supply observableVault/)
  }, 120_000)
})
