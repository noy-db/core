/**
 * family#169 — `check-architecture`'s `capsule-door-only` rule now covers a
 * DYNAMIC `import('…')`, not just a static clause.
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
   * ⭐ The ratchet half. A grandfathered entry that no longer matches the tree
   * must FAIL, or the map decays into a permanent exemption nobody re-reads —
   * which is how the original carve-out survived long enough to hide six sites.
   */
  it('the grandfather map is a closed set with a stale-entry guard', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).toMatch(/DYNAMIC_ENCLAVE_BYPASS\s*=\s*new Map\(/)
    expect(src).toMatch(/no longer dynamically imports/)
    // Exactly the five sites measured on family#169 — two specifiers in
    // via/classified/active.ts and one in kernel/collection.ts. If this count
    // changes, the map changed, and that is a decision to make deliberately.
    // ⚠️ Slice the LITERAL, not from the identifier: the comment above the map
    // names those paths too, and counting them conflated prose with rows.
    const start = src.indexOf('DYNAMIC_ENCLAVE_BYPASS = new Map(')
    const map = src.slice(start, src.indexOf('])', start))
    expect(map.match(/'[^']*capsule\/enclave-aes\/[^']*'/g)?.length).toBe(3)
  })
})
