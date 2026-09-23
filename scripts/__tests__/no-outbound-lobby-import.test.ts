/**
 * core#105 — `check-architecture`'s `no-outbound-lobby-import` guard.
 *
 * It enforces the one-way law: the lobby (orchestration) depends on
 * `@noy-db/hub/cargo` and the edge adapters, never the reverse.
 *
 * ⛔ IT SPENT ITS WHOLE LIFE SCANNING FOR `@klum-db/`, a scope that never
 * existed in this family — the lobby has been `@noy-db/lobby` since the
 * 2026-09-06 reset. The law was documented in four places and enforced in
 * none, and a core package importing the lobby would have passed silently.
 *
 * ⭐ SO "the guard passes" IS THE SYMPTOM, NOT THE EVIDENCE — a clean run is
 * exactly what the broken version produced, every run, for months. The only
 * assertion worth anything is that it FIRES on a planted violation, which is
 * what most of this file does. A test that only asserted a clean tree would
 * have passed against the dead guard too.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = REPO_ROOT + 'scripts/check-architecture.mjs'
/** Planted under HUB's src on purpose — see the exemption case below. */
const PROBE = REPO_ROOT + 'packages/hub/src/with-shape/__lobby_import_probe__.ts'

function runCheck(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}
const plant = (body: string): void => writeFileSync(PROBE, body, 'utf8')

afterEach(() => { if (existsSync(PROBE)) rmSync(PROBE) })

describe('check-architecture — no-outbound-lobby-import', () => {
  it('the tree as committed has no outbound lobby import', () => {
    const { status, out } = runCheck()
    expect(out).not.toMatch(/no-outbound-lobby-import/)
    expect(status).toBe(0)
  })

  it('FIRES on a static import of the lobby — the case the dead guard missed', () => {
    plant("import { Lobby } from '@noy-db/lobby'\nexport const x: typeof Lobby | null = null\n")
    const { status, out } = runCheck()
    expect(out).toMatch(/no-outbound-lobby-import/)
    expect(out).toMatch(/__lobby_import_probe__/)
    expect(status).not.toBe(0)
  })

  it('FIRES on a subpath import', () => {
    plant("export { thing } from '@noy-db/lobby/cargo'\n")
    expect(runCheck().out).toMatch(/no-outbound-lobby-import/)
  })

  it('FIRES on a dynamic import', () => {
    plant("export const load = async () => import('@noy-db/lobby')\n")
    expect(runCheck().out).toMatch(/no-outbound-lobby-import/)
  })

  it('FIRES on a SIDE-EFFECT import (no `from` clause) — the second hole', () => {
    plant("import '@noy-db/lobby'\n")
    expect(runCheck().out).toMatch(/no-outbound-lobby-import/)
  })

  it('the exemption is an EXACT name match, so hub is not exempt', () => {
    // ⚠️ The obvious repoint — `name.startsWith('@noy-db/')` — would exempt
    // every package in this repo and recreate the original silence behind a
    // live-looking regex. The probe above lives in `@noy-db/hub`, so the
    // firing cases are that control; this one states why they are placed there.
    plant("import '@noy-db/lobby'\n")
    const { out } = runCheck()
    expect(out).toMatch(/packages\/hub\/src/)
  })

  it('does NOT fire on a look-alike specifier', () => {
    plant("export { a } from '@noy-db/lobby-adapter'\nexport const b = 1\n")
    const { out } = runCheck()
    expect(out).not.toMatch(/no-outbound-lobby-import/)
  })

  it('does NOT fire on the specifier inside a comment or a runtime message', () => {
    plant([
      "// a doc comment mentioning import x from '@noy-db/lobby' must not trip it",
      "export const msg = \"moved: import it from '@noy-db/lobby' instead\"",
    ].join('\n') + '\n')
    const { out } = runCheck()
    expect(out).not.toMatch(/no-outbound-lobby-import/)
  })
})
