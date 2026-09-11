/**
 * #1319 — `check-architecture`'s `subtle-outside-enclave` BAN.
 *
 * `enclave-barrel-only` bans a file outside `kernel/enclave/**` from
 * IMPORTING past the barrel. It says nothing about a file calling
 * `globalThis.crypto.subtle` directly, which reaches around the fork-swap
 * contract just as completely — and is how `wrapped-deks.ts:100` came to
 * `exportKey('raw', dek)` on a key type the barrel says a fork may redefine.
 *
 * Introduced as a RATCHET over ten grandfathered files (38 calls); driven to
 * zero one file per commit during the capsule seam's Stage A and turned into
 * a flat ban. It is exercised here against the real script and the real
 * tree: a probe file with one `subtle.digest(` call is dropped under
 * `hub/src`, the script is expected to name it, and the probe is removed
 * again.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = REPO_ROOT + 'scripts/check-architecture.mjs'
const PROBE = REPO_ROOT + 'packages/hub/src/with-shape/__subtle_ratchet_probe__.ts'

function runCheck(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

afterEach(() => {
  if (existsSync(PROBE)) rmSync(PROBE)
})

describe('check-architecture — subtle-outside-enclave ban', () => {
  it('the tree as committed has NO direct crypto.subtle call outside kernel/enclave', () => {
    const { status, out } = runCheck()
    expect(out).not.toMatch(/subtle-outside-enclave/)
    expect(status).toBe(0)
  })

  // NOTE: match the DECLARATION, not a populated one. An earlier form of this
  // test required an inner `[` (`new Map([ [`), which an EMPTY map does not
  // have — so it passed while `const SUBTLE_OUTSIDE_ENCLAVE = new Map([])` was
  // still sitting in the script, ready to be refilled. The point of the ban is
  // that there is nowhere to add an exception.
  it('there is no grandfather map any more — the check is a ban, not a ratchet', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).not.toMatch(/SUBTLE_OUTSIDE_ENCLAVE\s*=\s*new Map\(/)
  })

  it('a NEW file calling crypto.subtle outside kernel/enclave fails, naming the check and the door', () => {
    writeFileSync(
      PROBE,
      "export async function probe(b: Uint8Array): Promise<ArrayBuffer> {\n  return globalThis.crypto.subtle.digest('SHA-256', b as BufferSource)\n}\n",
    )
    const { status, out } = runCheck()
    expect(status).not.toBe(0)
    expect(out).toMatch(/subtle-outside-enclave/)
    expect(out).toMatch(/__subtle_ratchet_probe__\.ts/)
    expect(out).toMatch(/kernel\/enclave\/index\.js/)
  })

  it('a subtle call that appears only inside a comment does not count', () => {
    writeFileSync(
      PROBE,
      "// callers used to do subtle.digest('SHA-256', b) here\n/** and `subtle.encrypt(...)` in docs */\nexport const probe = 1\n",
    )
    const { status, out } = runCheck()
    expect(out).not.toMatch(/subtle-outside-enclave/)
    expect(status).toBe(0)
  })
})
