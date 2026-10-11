/**
 * The one door (family#114): `noy-db` reaches the TUI lazily and lists every
 * verb; the `@noy-db/cli` shim translates the old spellings.
 *
 * These spawn the BUILT bins, because the thing under test is the dispatch
 * table and the exit codes — a unit import of the handlers would pass while
 * the bin printed the wrong help.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveBin } from '../src/commands/resolve-bin.js'

const BIN = resolve(__dirname, '..', 'dist', 'bin', 'noy-db.js')
const run = (args: string[], cwd = process.cwd()) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`build first: ${BIN} is missing`)
})

describe('noy-db — the one bin', () => {
  it('--help lists every verb family, including the ones that came from @noy-db/cli', () => {
    const { code, out } = run(['--help'])
    expect(code).toBe(0)
    for (const verb of ['add <collection>', 'user add', 'user rotate', 'backup', 'doctor crypto', 'pod inspect', 'pod verify', 'describe', 'config validate', 'config scaffold', 'config profiles', 'monitor', 'inspect']) {
      expect(out, verb).toContain(verb)
    }
  })

  it('config profiles lists all ten, and scaffold --help is help (not profile A)', () => {
    const profiles = run(['config', 'profiles'])
    expect(profiles.code).toBe(0)
    for (const id of 'ABCDEFGHIJ') expect(profiles.out).toMatch(new RegExp(`^  ${id}  `, 'm'))
    const help = run(['config', 'scaffold', '--help'])
    expect(help.code).toBe(0)
    expect(help.out).toMatch(/^Usage: noy-db config scaffold/)
    expect(help.out).not.toContain('export default')
  })

  it('a bad profile exits 2 and names the listing command, never a doc path', () => {
    const { code, err } = run(['config', 'scaffold', '--profile=Z'])
    expect(code).toBe(2)
    expect(err).toContain('noy-db config profiles')
    expect(err).not.toContain('topology-matrix')
  })

  it('the old spellings still work and print the new one once', () => {
    const { code, err } = run(['rotate'])
    expect(code).toBe(2) // missing --vault, as before — but it got there
    expect(err).toContain('`noy-db rotate` is now `noy-db user rotate`')
  })

  it('inspect without the TUI installed exits 2 and names the package to add', () => {
    const empty = mkdtempSync(join(tmpdir(), 'noy-db-one-bin-'))
    const { code, err } = run(['inspect', './noydb.config.mjs', '--vault=x'], empty)
    expect(code).toBe(2)
    expect(err).toContain('@noy-db/in-devtools-tui')
    expect(err).toContain('noy-db inspect')
  })
})

describe('resolveBin — walks node_modules by path', () => {
  it('finds a bin through an exports-restricted package, from a nested cwd, and returns null when absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'noy-db-resolve-'))
    const pkg = join(root, 'node_modules', '@noy-db', 'in-devtools-tui')
    mkdirSync(pkg, { recursive: true })
    // An `exports` map with only "." is exactly what makes require.resolve('<pkg>/package.json') refuse.
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@noy-db/in-devtools-tui', bin: { 'noydb-inspect': './dist/bin.js' }, exports: { '.': './dist/index.js' } }))
    const nested = join(root, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    expect(resolveBin('@noy-db/in-devtools-tui', 'noydb-inspect', nested)).toBe(join(pkg, 'dist', 'bin.js'))
    // CONTROL: a package that is not there, and a bin name the manifest does not carry.
    expect(resolveBin('@noy-db/not-installed', 'x', nested)).toBeNull()
    expect(resolveBin('@noy-db/in-devtools-tui', 'other-bin', nested)).toBeNull()
  })
})
