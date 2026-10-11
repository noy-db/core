/**
 * `@noy-db/cli` is a redirect (family#114). The one thing it owns is the
 * mapping from the old `noydb` spelling to the new `noy-db` one; the built bin
 * proves it exits 2 — never 0 — when it cannot find `create-noy-db`, so a
 * script that still calls `noydb` fails loudly instead of silently doing
 * nothing.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { translate } from '../src/translate.js'

const BIN = resolve(__dirname, '..', 'dist', 'bin', 'noydb.js')

describe('noydb → noy-db redirect', () => {
  it('maps inspect/verify under `pod` and passes every other command through', () => {
    expect(translate(['inspect', 'a.noydb'])).toEqual(['pod', 'inspect', 'a.noydb'])
    expect(translate(['verify', 'a.noydb'])).toEqual(['pod', 'verify', 'a.noydb'])
    expect(translate(['config', 'scaffold', '--profile=B'])).toEqual(['config', 'scaffold', '--profile=B'])
    expect(translate(['describe', 'a.noydb', '--format=json'])).toEqual(['describe', 'a.noydb', '--format=json'])
    expect(translate([])).toEqual([])
  })

  it('exits 2 and names create-noy-db when the target bin is not installed', () => {
    if (!existsSync(BIN)) throw new Error(`build first: ${BIN} is missing`)
    const empty = mkdtempSync(join(tmpdir(), 'noydb-redirect-'))
    const r = spawnSync(process.execPath, [BIN, 'config', 'profiles'], { cwd: empty, encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('is now `noy-db config profiles`')
    expect(r.stderr).toContain('create-noy-db')
  })

  it('--version answers without needing create-noy-db', () => {
    const empty = mkdtempSync(join(tmpdir(), 'noydb-redirect-'))
    const r = spawnSync(process.execPath, [BIN, '--version'], { cwd: empty, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
