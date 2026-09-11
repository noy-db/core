/**
 * `npm install @noy-db/hub` must be a working noy-db with nothing else in
 * node_modules (capsule seam spec, D2/D5). `@noy-db/attestation` is bundled
 * at build time, so neither the JS nor the .d.ts output may name it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as A from '@noy-db/attestation'
import type * as H from '../src/with-audit/attestation/types.js'

// Compile-time: the hub-owned copies must stay structurally identical to
// attestation's, in BOTH directions. Drift fails typecheck, not a consumer.
type Same<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : never) : never
type _Pins = [
  Same<A.AttestationFieldSchema, H.AttestationFieldSchema>,
  Same<A.QrPayload, H.QrPayload>,
  Same<A.RevocationList, H.RevocationList>,
  Same<A.VerifyInput, H.VerifyInput>,
  Same<A.VerifyResult, H.VerifyResult>,
  Same<A.SignatureScheme, H.SignatureScheme>,
]

const HUB = fileURLToPath(new URL('..', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|d\.ts)$/.test(name)) out.push(p)
  }
  return out
}

describe('hub has no runtime dependencies', () => {
  it('package.json declares none', () => {
    const pkg = JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  it('dist never imports @noy-db/attestation (bundled, not required)', () => {
    const offenders = walk(join(HUB, 'dist')).filter((f) =>
      /from\s+['"]@noy-db\/attestation['"]|import\(['"]@noy-db\/attestation['"]\)/.test(
        readFileSync(f, 'utf8'),
      ),
    )
    expect(offenders).toEqual([])
  })
})
