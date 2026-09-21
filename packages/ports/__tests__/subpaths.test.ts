/**
 * Every subpath resolves through the package's own `exports` map and the
 * function it advertises is callable — with a control. This is the gate the
 * consolidation was asked to prove: six entries built by tsup, and absence
 * alone cannot tell "tree-shaken" from "never wired". Self-reference
 * (`@noy-db/ports/<port>` from inside the package) goes through the same
 * `exports` resolution a consumer's install does, against `dist/` — so this
 * file is red until the package is built (turbo: test depends on build).
 */
import { describe, it, expect } from 'vitest'

const SUBPATHS: Record<string, string[]> = {
  to: ['runStoreConformanceTests'],
  as: ['runFormatConformanceTests'],
  at: ['runSealerConformanceTests', 'runDelegatingSealerObligations'],
  on: ['runCeremonyConformanceTests'],
  by: ['runMeshConformanceTests'],
  capsule: ['runCapsuleConformance', 'runEnclaveConformance'],
}

describe('@noy-db/ports — every subpath resolves and exports its suite', () => {
  for (const [port, fns] of Object.entries(SUBPATHS)) {
    it(`@noy-db/ports/${port} → ${fns.join(', ')}`, async () => {
      const specifier = ['@noy-db/ports', port].join('/') // built at runtime so vite resolves nothing at transform time
      const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
      for (const fn of fns) expect(typeof mod[fn], `${port}.${fn}`).toBe('function')
    })
  }

  it('control: a subpath the map does not declare fails to resolve', async () => {
    const specifier = ['@noy-db/ports', 'nope'].join('/')
    await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow()
  })
})
