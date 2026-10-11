/**
 * `noy-db add` (family#118): the catalog is read live-then-bundled, the prefix
 * decides the trust line, the package manager comes from the lockfile, and
 * `--dry-run` installs nothing. The install itself is not exercised (it would
 * hit the network); `installArgv` is tested as the pure function it is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPackage, bundledCatalog, detectPackageManager, findPackage, formatList, installArgv, loadCatalog, normalisePrefix, snippetFor,
} from '../src/commands/add-package.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'noy-db-add-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const failingFetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch

describe('the catalog', () => {
  it('ships a snapshot with every prefix and the trust text for each', () => {
    const c = bundledCatalog()
    expect(c.schemaVersion).toBe(1)
    for (const p of ['to-', 'in-', 'on-', 'as-', 'by-', 'at-']) {
      expect(c.prefixes[p]?.trust.length, p).toBeGreaterThan(20)
      expect(c.packages.some((x) => x.prefix === p), p).toBe(true)
    }
    expect(c.packages.length).toBeGreaterThan(50)
  })
  it('falls back to the snapshot when the live fetch fails, and says so', async () => {
    const r = await loadCatalog({ fetchImpl: failingFetch })
    expect(r.source).toBe('bundled')
    expect(r.catalog.packages.length).toBe(bundledCatalog().packages.length)
  })
  it('uses a live catalog when it answers with the right shape — and ignores a wrong one', async () => {
    const live = { ...bundledCatalog(), packages: bundledCatalog().packages.slice(0, 3) }
    const ok = (() => Promise.resolve(new Response(JSON.stringify(live), { status: 200 }))) as unknown as typeof fetch
    expect((await loadCatalog({ fetchImpl: ok })).source).toBe('live')
    const bad = (() => Promise.resolve(new Response(JSON.stringify({ hello: 1 }), { status: 200 }))) as unknown as typeof fetch
    expect((await loadCatalog({ fetchImpl: bad })).source).toBe('bundled')
  })
  it('--offline never fetches', async () => {
    let called = 0
    const spy = (() => { called++; return Promise.reject(new Error('x')) }) as unknown as typeof fetch
    await loadCatalog({ offline: true, fetchImpl: spy })
    expect(called).toBe(0)
  })
})

describe('resolving a name', () => {
  it('accepts the full name, the prefixed name, and the bare suffix', () => {
    const c = bundledCatalog()
    expect(findPackage(c, '@noy-db/to-aws-s3')?.package).toBe('@noy-db/to-aws-s3')
    expect(findPackage(c, 'to-aws-s3')?.package).toBe('@noy-db/to-aws-s3')
    expect(findPackage(c, 'aws-s3')?.package).toBe('@noy-db/to-aws-s3')
    expect(findPackage(c, 'nope-nothing')).toBeUndefined()
  })
  it('normalises a prefix in every spelling and rejects a non-prefix', () => {
    for (const s of ['to', 'to-', '@noy-db/to-']) expect(normalisePrefix(s)).toBe('to-')
    expect(normalisePrefix('storage')).toBeUndefined()
    expect(normalisePrefix(undefined)).toBeUndefined()
  })
})

describe('the trust line and the snippet follow the prefix', () => {
  it('as- warns about plaintext, at- about the host, to- promises ciphertext', () => {
    const c = bundledCatalog()
    expect(c.prefixes['as-']!.trust).toMatch(/PLAINTEXT/)
    expect(c.prefixes['at-']!.trust).toMatch(/NON-zero-knowledge/)
    expect(c.prefixes['to-']!.trust).toMatch(/ciphertext only/)
    const s3 = findPackage(c, 'to-aws-s3')!
    expect(snippetFor(s3)).toContain("from '@noy-db/to-aws-s3'")
    expect(snippetFor(s3)).toContain('toAwsS3')
    const xlsx = findPackage(c, 'as-xlsx')!
    expect(snippetFor(xlsx)).toMatch(/plaintext/)
  })
})

describe('package manager + install argv', () => {
  it('detects from the lockfile; pnpm by default', async () => {
    expect(detectPackageManager(root)).toBe('pnpm')
    await writeFile(join(root, 'package-lock.json'), '{}'); expect(detectPackageManager(root)).toBe('npm')
    await writeFile(join(root, 'yarn.lock'), ''); expect(detectPackageManager(root)).toBe('yarn')
    await writeFile(join(root, 'bun.lock'), ''); expect(detectPackageManager(root)).toBe('bun')
  })
  it('builds the right verb per manager', () => {
    expect(installArgv('pnpm', '@noy-db/to-file', false)).toEqual(['pnpm', 'add', '@noy-db/to-file'])
    expect(installArgv('npm', '@noy-db/to-file', true)).toEqual(['npm', 'install', '--save-dev', '@noy-db/to-file'])
    expect(installArgv('yarn', 'x', true)).toEqual(['yarn', 'add', '--dev', 'x'])
    expect(installArgv('bun', 'x', false)).toEqual(['bun', 'add', 'x'])
  })
})

describe('addPackage', () => {
  it('--dry-run resolves, picks the command and the trust line, installs nothing', async () => {
    await writeFile(join(root, 'package.json'), '{"name":"p"}')
    const r = await addPackage('to-aws-s3', { root, dryRun: true, fetchImpl: failingFetch })
    expect(r.installed).toBe(false)
    expect(r.command).toEqual(['pnpm', 'add', '@noy-db/to-aws-s3'])
    expect(r.trust).toMatch(/ciphertext/)
    expect(r.wired).toBeNull()
  })
  it('an unknown name throws with suggestions and the --list hint', async () => {
    await expect(addPackage('aws', { root, dryRun: true, fetchImpl: failingFetch })).rejects.toThrow(/did you mean.*to-aws-s3[\s\S]*--list/)
  })
})

describe('formatList', () => {
  it('groups by prefix with the plaintext column, and filters by one prefix', () => {
    const c = bundledCatalog()
    const all = formatList(c)
    for (const p of ['to-', 'in-', 'on-', 'as-', 'by-', 'at-']) expect(all).toContain(p)
    const only = formatList(c, 'at-')
    expect(only).toContain('@noy-db/at-')
    expect(only).not.toContain('@noy-db/to-')
  })
})
