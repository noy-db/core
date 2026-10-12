/**
 * family#169 — `check-architecture`'s `capsule-door-only` rule covers a
 * DYNAMIC `import('…')`, not just a static clause. family#168 then emptied the
 * grandfather map it shipped with, so the last case asserts the map's ABSENCE.
 *
 * ⛔ Why it was needed: the check carried a carve-out saying a dynamic import
 * "is not statically analyzable here". That is true of a COMPUTED specifier and
 * false of a literal one — and six literal dynamic imports had reached past the
 * capsule barrel while `pnpm check:architecture` stayed green. A lazy import is
 * not an exemption: `enclave-aes` ships inside hub whatever `#capsule` is bound
 * to, so one of these loads the REFERENCE capsule even in a build bound to
 * another, which would let a capsule that refuses a group keep working.
 *
 * Exercised against the real script and the real tree, following
 * `subtle-outside-capsule.test.ts`: a probe file is dropped under `hub/src`, the
 * script is expected to name it, and the probe is removed again.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = REPO_ROOT + 'scripts/check-architecture.mjs'
const PROBE = REPO_ROOT + 'packages/hub/src/with-shape/__dynamic_capsule_probe__.ts'

function runCheck(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

afterEach(() => {
  if (existsSync(PROBE)) rmSync(PROBE)
})

describe('check-architecture — capsule-door-only covers dynamic imports', () => {
  it('the tree as committed passes', () => {
    const { status, out } = runCheck()
    expect(out).not.toMatch(/capsule-door-only/)
    expect(status).toBe(0)
  })

  it('a NEW dynamic import past the barrel fails, naming the file and the door', () => {
    writeFileSync(
      PROBE,
      "export async function probe(): Promise<unknown> {\n" +
      "  const m = await import('../capsule/enclave-aes/classify/find.js')\n" +
      "  return m\n}\n",
    )
    const { status, out } = runCheck()
    expect(status).not.toBe(0)
    expect(out).toMatch(/capsule-door-only/)
    expect(out).toMatch(/__dynamic_capsule_probe__\.ts/)
    expect(out).toMatch(/dynamically imports/)
    // The message must say why laziness is not an exemption, or the next author
    // reads the failure as pedantry and adds a map entry.
    expect(out).toMatch(/ships inside hub/)
  })

  it('a dynamic import of the DOOR is fine — that is the fix the message asks for', () => {
    writeFileSync(
      PROBE,
      "export async function probe(): Promise<unknown> {\n" +
      "  const m = await import('../capsule/index.js')\n" +
      "  return m\n}\n",
    )
    const { status, out } = runCheck()
    expect(out).not.toMatch(/capsule-door-only/)
    expect(status).toBe(0)
  })

  it('a dynamic import that appears only in a comment does not count', () => {
    writeFileSync(
      PROBE,
      "// we used to await import('../capsule/enclave-aes/classify/find.js') here\n" +
      "/** see `import('../capsule/enclave-aes/crypto.js')` in the old docs */\n" +
      "export const probe = 1\n",
    )
    const { status, out } = runCheck()
    expect(out).not.toMatch(/capsule-door-only/)
    expect(status).toBe(0)
  })

  /**
   * ⭐ family#168 — the grandfather map is GONE, and this case is what stops it
   * coming back. #169 created it with five rows and said they were waiting on a
   * contract decision; the decision promoted two primitives and moved the four
   * classify orchestrators into `capsule/plumbing/`, which routed all five.
   *
   * ⛔ A map here is not a smaller version of the fix, it is a different
   * outcome: a row buys the laziness and silently keeps the REFERENCE capsule,
   * while a `makeCapsule()` thunk buys both. So the absence is asserted, and
   * the failure message must point at the thunk — otherwise the next author
   * reads "import the door" as impossible for a lazy call site and adds a row.
   */
  it('has no grandfather map, and says where an unroutable orchestrator goes', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).not.toMatch(/DYNAMIC_ENCLAVE_BYPASS\s*=\s*new Map\(/)
    // No leftover stale-row machinery either — a guard with nothing to guard
    // reads as a map that merely happens to be empty right now.
    expect(src).not.toMatch(/no longer dynamically imports/)
    expect(src).toMatch(/bind it in makeCapsule\(\)/)
  })

  /**
   * The routing is only real if the classify engines actually left the capsule.
   * A door-shaped `import()` at the call site with the engines still inside
   * `enclave-aes/classify/` would pass every case above.
   */
  it('the classify orchestrators live in the plumbing, not in enclave-aes', () => {
    const plumbing = REPO_ROOT + 'packages/hub/src/capsule/plumbing/'
    for (const f of ['classify-verify.ts', 'classify-reveal.ts']) {
      expect(existsSync(plumbing + f), `${f} must be plumbing — identical for every capsule`).toBe(true)
    }
    const enclave = REPO_ROOT + 'packages/hub/src/capsule/enclave-aes/classify/'
    for (const f of ['verify.ts', 'reveal.ts']) {
      expect(existsSync(enclave + f), `${f} moved to the plumbing; a copy here is the drift`).toBe(false)
    }
  })
})
