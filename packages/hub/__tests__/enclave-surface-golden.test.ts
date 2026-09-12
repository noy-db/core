/**
 * Golden export-surface freeze for `capsule/enclave-aes/index.ts` — the fork-swap
 * contract (S5 family doors, Task 9).
 *
 * `capsule/enclave-aes/` (crypto.ts + record-keys/**) is the hub's crypto
 * interior — the piece a forked sister project replaces wholesale, honoring
 * only this barrel's interface. This test freezes its export list against a
 * checked-in baseline (`enclave-surface.golden.json`) so drift fails CI —
 * adding requires a visible baseline update, removing / renaming fails
 * loudly. Not a published `@noy-db/hub/*` subpath (internal to the kernel
 * spine) — the golden discipline still applies because forks depend on it.
 *
 * MECHANISM — identical to the `/to` golden test (see its header for the
 * rationale): runtime `Object.keys` freezes the VALUE exports; a source-parse
 * of the `export [type] { … } from` blocks freezes both VALUE and TYPE-only
 * exports; a compile-time `import type` list asserts every baselined type
 * still resolves so a removal also breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as enclave from '../src/capsule/enclave-aes/index.js'
import type { DeterministicContext, EnclaveKey, EnclaveKeyPair, SecretKeyUsage, SealingContext } from '../src/capsule/enclave-aes/index.js'
import type { BrokerProofCanonicalParts, VerifyBrokerProofArgs, IssuedChallenge } from '../src/capsule/enclave-aes/index.js'

interface Surface {
  readonly values: readonly string[]
  readonly types: readonly string[]
}

function read(url: string): string {
  return readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
}

/** Strip comments, then collect names from `export [type] { … } from` blocks. */
function parseExports(src: string): { values: string[]; types: string[] } {
  // ⛔ LINE COMMENTS FIRST. Stripping block comments first lets a `//` comment
  // containing a glob like `classify/**` read as a block-comment OPENER: the
  // regex then runs to the next `*/` and deletes everything between, which in
  // this file silently swallowed a 15-name export block. The parse still
  // "succeeded" and reported the shortfall as a surface change.
  //
  // `scripts/check-architecture.mjs` carries this exact lesson already — its
  // `stripComments` notes that line-comments-first "cannot have the inverse
  // problem", because a `//` inside a block comment is removed harmlessly. The
  // fix never reached this copy of the logic.
  const clean = src
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const collect = (re: RegExp): string[] => {
    const out = new Set<string>()
    for (const m of clean.matchAll(re)) {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) out.add(name)
      }
    }
    return [...out].sort()
  }
  // ⚠️ THREE export forms, not one. Stage C's plumbing extraction made the
  // barrel bind its cipher-dependent half by destructuring the assembled
  // capsule (`export const { … } = aesCapsule`) and declare `RecordCodec` as a
  // type ALIAS rather than a re-export. A parser that knew only
  // `export { … } from` still PASSED on the old names while silently seeing 63
  // of 97 — a golden that reads two thirds of the surface and reports success
  // is the same failure as a golden nobody runs.
  return {
    types: [...new Set([
      ...collect(/export\s+type\s*\{([^}]*)\}\s*from/g),
      ...collect(/export\s+type\s+(\w+)\s*[<=]/g),
    ])].sort(),
    values: [...new Set([
      ...collect(/export\s*\{([^}]*)\}\s*from/g),
      ...collect(/export\s+const\s*\{([^}]*)\}\s*=/g),
    ])].sort(),
  }
}

const baseline: Surface = JSON.parse(read('./enclave-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/capsule/enclave-aes/index.ts'))

describe('capsule/enclave-aes — golden export surface (fork-swap contract)', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(enclave)
      .filter((k) => (enclave as Record<string, unknown>)[k] !== undefined)
      .sort()
    expect(runtime).toEqual([...baseline.values].sort())
  })

  it('value exports in source match the baseline (source parse)', () => {
    expect(parsed.values).toEqual([...baseline.values].sort())
  })

  it('type exports match the frozen baseline (source parse)', () => {
    expect(parsed.types).toEqual([...baseline.types].sort())
  })
})

// Compile-time exhaustiveness: every baselined type must still be exported.
type _FrozenTypes = [
  DeterministicContext<unknown>,
  EnclaveKey,
  EnclaveKeyPair,
  SecretKeyUsage,
  SealingContext,
  BrokerProofCanonicalParts,
  VerifyBrokerProofArgs,
  IssuedChallenge,
]
