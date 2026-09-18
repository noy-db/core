/**
 * #54 — every published PORT must be bindable ALONE.
 *
 * A port subpath exists so a satellite can write its whole implementation
 * against that one entry. Nothing measured whether it still can, and in
 * core#41 that gap nearly shipped: the ruling was to add `EchoCeremony` and
 * `BeginEchoUnlockOptions` to `/on`, which would have left `beginEchoUnlock`
 * — the only way to OBTAIN an `EchoCeremony` — on the root barrel. Every
 * name would have resolved, every golden would have moved and passed, and
 * `/on` would still have been unusable for a player.
 *
 * ⭐ **The measurable object is the consumer's IMPORT LIST, not the export
 * count.** So each fixture is a satellite's whole import list — one line —
 * plus a MINIMAL REAL CALLER: it implements the contract and calls the
 * functions. A fixture that only referenced types would compile throughout
 * the defect above and prove nothing.
 *
 * ## Why this cannot be a grep, and is a fixture per port
 *
 * There is nothing textual to look for. In the failure mode every identifier
 * resolves; what is missing is reachability of a *value* the author needs,
 * which only a compiler that tries to write the call can discover. `on`
 * named this the third of three export-defect shapes — (1) absence
 * unfalsifiable, (2) documented but non-existent, (3) exported but unusable.
 * The family's prose gate covers (2) and is blind to this one.
 *
 * ## What the programs resolve against
 *
 * `dist`, through package.json's `exports` map — a consumer's view, not
 * ours. The fixture tsconfigs extend the REPO BASE rather than hub's own,
 * because hub's maps `#capsule` into `./src` and would type the fixtures
 * against source. That makes `pnpm build` a precondition, asserted below
 * with a message that says so: a missing `dist` fails tsc with TS2307, which
 * reads exactly like "the port is not bindable" and is not.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(HUB, '__tests__/fixtures/54-bindable-alone')
// pnpm hoists typescript to the workspace root; the package has no local copy.
const TSC = join(HUB, '../../node_modules/typescript/bin/tsc')

/**
 * The five published ports. Stated as a literal so a port added to
 * package.json without a fixture fails the count below rather than joining
 * the set silently — the same reason `subpath-surfaces.test.ts` states 55.
 */
const PORTS = ['to', 'at', 'as', 'by', 'on'] as const

function typecheck(project: string): { code: number; output: string } {
  try {
    const output = execFileSync('node', [TSC, '--noEmit', '-p', join(DIR, project)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('#54 — the instrument itself', () => {
  it('has a fixture for every published port, and no orphans', () => {
    const published = Object.keys(
      (JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports,
    )
    for (const port of PORTS) {
      expect(published, `${port} is not a published subpath`).toContain(`./${port}`)
    }
    const fixtures = readdirSync(DIR).filter(f => f.endsWith('.ts') && !f.startsWith('control'))
    expect(fixtures.sort()).toEqual([...PORTS].map(p => `${p}.ts`).sort())
  })

  it('typechecks against the BUILT dist — run `pnpm --filter @noy-db/hub build` first', () => {
    // Asserted explicitly because the failure it prevents is a wrong
    // NEGATIVE: without dist, every fixture fails TS2307 and the suite would
    // report five unbindable ports instead of a missing build.
    for (const port of PORTS) {
      const dts = join(HUB, `dist/port/${port}/index.d.ts`)
      expect(existsSync(dts), `${dts} missing — build hub before running this suite`).toBe(true)
    }
  })

  it('CONTROL: an unexported name fails on every port, so a green fixture means something', () => {
    const { code, output } = typecheck('tsconfig.control.json')
    expect(code, 'control-not-exported.ts must NOT compile').not.toBe(0)
    for (const port of PORTS) {
      expect(output).toContain(`Module '"@noy-db/hub/${port}"' has no exported member 'thisIsNotExportedByAnyPort'`)
    }
  })
})

describe('#54 — each port is bindable ALONE', () => {
  for (const port of PORTS) {
    it(`@noy-db/hub/${port} — a satellite compiles against it and nothing else`, () => {
      const { code, output } = typecheck(`tsconfig.${port}.json`)
      expect(code, `expected ${DIR}/${port}.ts to compile:\n${output}`).toBe(0)
    }, 60_000)
  }

  for (const port of PORTS) {
    it(`@noy-db/hub/${port} — the fixture imports ONLY its own port`, () => {
      // The repair a red fixture invites is adding the root barrel, which
      // makes it compile and destroys the property being measured. This is
      // the guard against a green test that has stopped meaning anything.
      const src = readFileSync(join(DIR, `${port}.ts`), 'utf8')
      const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
      expect(specifiers.length, 'the fixture must have at least one import').toBeGreaterThan(0)
      expect([...new Set(specifiers)]).toEqual([`@noy-db/hub/${port}`])
    })
  }
})
