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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, 'fixtures', 'vitest.suites.config.ts')
const REPO_ROOT = join(HERE, '..', '..', '..')
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
async function runSuite(name: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('npx', ['vitest', 'run', '--config', CONFIG, name], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // ⚠️ 32MB, because the default is 1MB and a verbose child run overflows
      // it — the spawn then fails with ENOBUFS and TRUNCATED output, so a
      // match against the summary line silently stops finding it.
      maxBuffer: 32 * 1024 * 1024,
    })
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
async function expectRefused(suite: string, because: RegExp): Promise<void> {
  const { code, out } = await runSuite(suite)
  expect(code, `the kit PASSED a store it must refuse:\n${out}`).not.toBe(0)
  expect(out).toMatch(because)
  expect(out, `more than one case reacted — the control no longer attributes:\n${out}`).toMatch(
    /Tests {2}1 failed \|/,
  )
}

describe('the adapter conformance kit, run against stores broken in one way each', () => {
  it('⛔ FAILS a store that accepts any expectedVersion', async () => {
    await expectRefused('broken-ignores-expected-version', /put with wrong expectedVersion throws ConflictError/)
  }, 120_000)

  it('⛔ FAILS a store that strips the _del delete marker (#589)', async () => {
    await expectRefused('broken-drops-delete-marker', /round-trips a delete-marker envelope/)
  }, 120_000)

  it('⛔ FAILS a store implementing tx() without declaring capabilities.txAtomic', async () => {
    await expectRefused('broken-undeclared-tx', /does not declare capabilities\.txAtomic/)
  }, 120_000)
})
