/**
 * core#55 — `sources-tracked` must not flag COVERAGE OUTPUT, and must still
 * flag a genuinely untracked source file.
 *
 * ## The defect, and why nothing caught it for so long
 *
 * The check asks git for ignored files under `packages/*​/src/**`. In a DEFAULT
 * git pathspec `*` MATCHES `/`, so that pattern also matches
 * `packages/in-rest/coverage/src/index.html` — the star swallows
 * `in-rest/coverage`. The comment above the call states the opposite rule in
 * so many words ("build output, dist/, node_modules and real coverage reports
 * are ignored ON PURPOSE and always will be"), so the code contradicted its own
 * documented intent.
 *
 * ⭐ It was UNREACHABLE BY CONSTRUCTION until core#55. `test:ci` passed
 * `--coverage`, but `@vitest/coverage-v8` was in no manifest and no lockfile,
 * so coverage had never run once and the artefacts that trip it had never
 * existed. Installing the provider produced 87 violations on the first run.
 *
 * ## Why this test and not a wider one
 *
 * Both directions, because only the pair is falsifiable: a pathspec that
 * matches NOTHING would also pass the first case, and that is precisely the
 * "gate reporting green having checked nothing" failure (#46). So the second
 * case proves the check can still fail.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = REPO_ROOT + 'scripts/check-architecture.mjs'

/** Shaped exactly like vitest's lcov html output: a `src/` nested under `coverage/`. */
const COVERAGE_DIR = REPO_ROOT + 'packages/in-rest/coverage'
const COVERAGE_FILE = COVERAGE_DIR + '/src/index.html'

/**
 * A real one: ignored, and genuinely inside a package's OWN `src/`.
 * `.log` because `.gitignore:139` is `*.log` — the probe has to be ignored for
 * the control to mean anything, and it must not be one of the three DROPPINGS
 * the check exempts by filename.
 */
const SOURCE_PROBE = REPO_ROOT + 'packages/hub/src/__sources_tracked_probe__.log'

function run(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

afterEach(() => {
  rmSync(COVERAGE_DIR, { recursive: true, force: true })
  rmSync(SOURCE_PROBE, { force: true })
})

describe('core#55 — sources-tracked pathspec is anchored per segment', () => {
  it('does NOT flag coverage output nested under a package', () => {
    mkdirSync(COVERAGE_DIR + '/src', { recursive: true })
    writeFileSync(COVERAGE_FILE, '<html><body>coverage report</body></html>\n')

    // Non-vacuity: the file must really be ignored, or this passes for the
    // wrong reason. `.gitignore:34` is `packages/*/coverage/`.
    const ignored = spawnSync('git', ['check-ignore', COVERAGE_FILE], { cwd: REPO_ROOT })
    expect(ignored.status).toBe(0)

    const { status, out } = run()
    expect(out).not.toMatch(/coverage\/src\/index\.html/)
    expect(status).toBe(0)
  })

  it('STILL flags an ignored file inside a package\'s own src/ (the control)', () => {
    writeFileSync(SOURCE_PROBE, 'export const probe = 1\n')

    const { status, out } = run()
    expect(out).toMatch(/__sources_tracked_probe__/)
    expect(out).toMatch(/GIT-IGNORED but sits under/)
    expect(status).not.toBe(0)
  })
})
