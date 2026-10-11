/**
 * `noy-db doctor` (family#116): one fixture per id that FIRES, and a control
 * per group that does not — a check that fires on everything is a check that
 * tests nothing. Every check runs without a secret.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { applyFixes, doctor, formatReport, type DoctorReport } from '../src/commands/doctor.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'noy-db-doctor-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const ids = (r: DoctorReport) => r.findings.map((x) => x.id).sort()
const has = (r: DoctorReport, id: string) => r.findings.some((x) => x.id === id)

let seq = 0
/** Returns the config path. Each call writes a NEW file name: Node caches ESM by URL, so rewriting
 *  the same path would hand the second `doctor()` the first module. */
async function project(opts: { manifest?: object; config?: string; gitignore?: string; env?: boolean } = {}): Promise<string | undefined> {
  await writeFile(join(root, 'package.json'), JSON.stringify(opts.manifest ?? { name: 'p', dependencies: { '@noy-db/hub': '0.0.0' } }))
  let configPath: string | undefined
  if (opts.config !== undefined) { configPath = join(root, `noydb.config.${++seq}.mjs`); await writeFile(configPath, opts.config) }
  if (opts.gitignore !== undefined) await writeFile(join(root, '.gitignore'), opts.gitignore)
  if (opts.env) await writeFile(join(root, '.env'), 'NOYDB_SECRET=x\n')
  return configPath
}

/** doctor() against the config `project()` just wrote. */
const run = async (configPath: string | undefined, extra: Parameters<typeof doctor>[0] = {}) =>
  doctor({ root, noSatellites: true, ...(configPath ? { configPath } : {}), ...extra })

/** An in-memory store module the config can import; vault rows are whatever the test seeds. */
async function storeModule(rows: Record<string, Record<string, Record<string, unknown>>> = {}, name = 'file') {
  const file = `store.${++seq}.mjs`
  const p = join(root, file)
  await writeFile(p, `
const rows = ${JSON.stringify(rows)}
export const store = {
  name: ${JSON.stringify(name)},
  async get(v, c, id) { const r = rows[v]?.[c]?.[id]; return r ? { _v: 1, _iv: '', _data: JSON.stringify(r) } : null },
  async list(v, c) { return Object.keys(rows[v]?.[c] ?? {}) },
  async put() {}, async delete() {}, async saveAll() {},
  async listVaults() { return Object.keys(rows) },
}
`)
  return `./${file}`
}

describe('doctor — secret (NOY-S)', () => {
  it('S001 fires on a literal secret; control: env-read secret does not', async () => {
    const c = await project({ config: `export default { user: 'u', secret: 'correct horse battery staple' }` })
    expect(has(await run(c), 'NOY-S001')).toBe(true)
    const c2 = await project({ config: `export default { user: 'u', secret: process.env.NOYDB_SECRET }` })
    expect(has(await run(c2), 'NOY-S001')).toBe(false)
  })
  it('S003 fires on managed mode without a sealer', async () => {
    const c = await project({ config: `export default { user: 'u', secretMode: 'managed' }` })
    expect(has(await run(c), 'NOY-S003')).toBe(true)
  })
})

describe('doctor — capsule (NOY-C)', () => {
  it('C001 is a warn in dev and an error in prod; control: encrypt unset', async () => {
    const c = await project({ config: `export default { user: 'u', encrypt: false }` })
    const dev = await run(c, { mode: 'dev' })
    const prod = await run(c, { mode: 'prod' })
    expect(dev.findings.find((x) => x.id === 'NOY-C001')?.level).toBe('warn')
    expect(prod.findings.find((x) => x.id === 'NOY-C001')?.level).toBe('error')
    const c2 = await project({ config: `export default { user: 'u' }` })
    expect(has(await run(c2), 'NOY-C001')).toBe(false)
  })
  it('C002 fires when exclave-plain is a dependency', async () => {
    const c = await project({ manifest: { dependencies: { '@noy-db/hub': '0', '@noy-db/exclave-plain': '0' } } })
    expect(has(await run(c), 'NOY-C002')).toBe(true)
  })
})

describe('doctor — topology (NOY-T)', () => {
  it('T001 fires on a memory store (error in prod); T002 fires with no sync', async () => {
    const mod = await storeModule({}, 'memory')
    const c = await project({ config: `import { store } from '${mod}'\nexport default { user: 'u', store }` })
    const r = await run(c, { mode: 'prod' })
    expect(r.findings.find((x) => x.id === 'NOY-T001')?.level).toBe('error')
    expect(has(r, 'NOY-T002')).toBe(true)
  })
  it('control: a persistent store with a sync target fires neither', async () => {
    const mod = await storeModule({}, 'file')
    const c = await project({ config: `import { store } from '${mod}'\nexport default { user: 'u', store, sync: [{ store, role: 'backup' }] }` })
    const r = await run(c)
    expect(has(r, 'NOY-T001')).toBe(false)
    expect(has(r, 'NOY-T002')).toBe(false)
  })
})

describe('doctor — recovery (NOY-R), read from the store without a secret', () => {
  it('R001 fires on a vault with users and no recovery doc; control: a paper entry clears it', async () => {
    const mod = await storeModule({ acme: { _keyring: { alice: { role: 'owner' } } } })
    const c = await project({ config: `import { store } from '${mod}'\nexport default { user: 'alice', store }` })
    expect(has(await run(c), 'NOY-R001')).toBe(true)
    const mod2 = await storeModule({ acme: { _keyring: { alice: { role: 'owner' } }, _meta: { 'recovery-paper': { entries: [{ codeId: 'x' }] } } } })
    const c2 = await project({ config: `import { store } from '${mod2}'\nexport default { user: 'alice', store }` })
    expect(has(await run(c2), 'NOY-R001')).toBe(false)
  })
  it('R002 fires on managed mode with paper only; a Shamir entry clears it', async () => {
    const paperOnly = await storeModule({ acme: { _keyring: { alice: { role: 'owner' } }, _meta: { 'recovery-paper': { entries: [{}] } } } })
    const c = await project({ config: `import { store } from '${paperOnly}'\nexport default { user: 'alice', store, secretMode: 'managed', sealingKey: {} }` })
    expect(has(await run(c), 'NOY-R002')).toBe(true)
    const shamir = await storeModule({ acme: { _keyring: { alice: { role: 'owner' } }, _meta: { 'recovery-shamir': { entries: [{ k: 2, n: 3 }] } } } })
    const c2 = await project({ config: `import { store } from '${shamir}'\nexport default { user: 'alice', store, secretMode: 'managed', sealingKey: {} }` })
    expect(has(await run(c2), 'NOY-R002')).toBe(false)
  })
  it('R003 fires on one owner among several users; control: two owners', async () => {
    const one = await storeModule({ acme: { _keyring: { alice: { role: 'owner' }, bob: { role: 'operator' } }, _meta: { 'recovery-paper': { entries: [{}] } } } })
    const c = await project({ config: `import { store } from '${one}'\nexport default { user: 'alice', store }` })
    expect(has(await run(c), 'NOY-R003')).toBe(true)
    const two = await storeModule({ acme: { _keyring: { alice: { role: 'owner' }, bob: { role: 'owner' } }, _meta: { 'recovery-paper': { entries: [{}] } } } })
    const c2 = await project({ config: `import { store } from '${two}'\nexport default { user: 'alice', store }` })
    expect(has(await run(c2), 'NOY-R003')).toBe(false)
  })
  it('an empty vault (no keyring rows) says nothing — nothing has been created yet', async () => {
    const mod = await storeModule({ acme: {} })
    const c = await project({ config: `import { store } from '${mod}'\nexport default { user: 'alice', store }` })
    expect(ids(await run(c)).filter((i) => i.startsWith('NOY-R'))).toEqual([])
  })
})

describe('doctor — dependencies (NOY-D)', () => {
  it('D001 fires without hub; D002 fires when the config imports an uninstalled @noy-db package', async () => {
    const c = await project({ manifest: { dependencies: {} }, config: `import { toAwsS3 } from '@noy-db/to-aws-s3'\nexport default { user: 'u' }` })
    const r = await run(c)
    expect(has(r, 'NOY-D001')).toBe(true)
    expect(r.findings.find((x) => x.id === 'NOY-D002')?.message).toContain('@noy-db/to-aws-s3')
  })
  it('D004 fires when the config file does not load', async () => {
    const c = await project({ config: `export default {` })
    expect(has(await run(c), 'NOY-D004')).toBe(true)
  })
})

describe('doctor — hygiene (NOY-H) and --fix', () => {
  it('H001 fires on .env without a gitignore line; applyFixes adds it idempotently', async () => {
    const c = await project({ env: true, gitignore: 'node_modules\n' })
    const r = await run(c)
    expect(has(r, 'NOY-H001')).toBe(true)
    expect(applyFixes(root, r)).toEqual(['.gitignore += .env, .env.*'])
    expect(has(await run(c), 'NOY-H001')).toBe(false)
    const again = await run(c)
    expect(applyFixes(root, again)).toEqual([]) // nothing left to fix; the file is not rewritten
    const gi = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gi.match(/^\.env$/gm)?.length).toBe(1)
  })
  it('control: .env already ignored', async () => {
    const c = await project({ env: true, gitignore: '.env\n' })
    expect(has(await run(c), 'NOY-H001')).toBe(false)
  })
})

describe('doctor — report shape', () => {
  it('counts match findings, ran lists every group, and format lists errors first', async () => {
    const c = await project({ env: true, gitignore: '', config: `export default { user: 'u', secret: 'literal', encrypt: false }` })
    const r = await run(c)
    expect(r.ran).toEqual(['NOY-S', 'NOY-C', 'NOY-T', 'NOY-R', 'NOY-D', 'NOY-H'])
    expect(r.counts.error + r.counts.warn + r.counts.info).toBe(r.findings.length)
    const text = formatReport(r)
    const firstFinding = text.split('\n').find((l) => /NOY-/.test(l)) ?? ''
    expect(firstFinding).toMatch(/✗/) // an error line comes before any warn/info
    for (const x of r.findings) expect(x.fix.length, x.id).toBeGreaterThan(10)
  })
})

describe('noy-db doctor — the bin', () => {
  const BIN = join(__dirname, '..', 'dist', 'bin', 'noy-db.js')
  const run = (args: string[]) => spawnSync(process.execPath, [BIN, 'doctor', ...args], { cwd: root, encoding: 'utf8' })

  it('exits 1 at the default fail level only on an error; --fail-level=warn tightens it; --json is parseable', async () => {
    if (!existsSync(BIN)) throw new Error(`build first: ${BIN}`)
    const c = (await project({ config: `export default { user: 'u', encrypt: false }` }))!  // a warn in dev, no errors
    expect(run([c]).status).toBe(0)
    expect(run([c, '--fail-level=warn']).status).toBe(1)
    const j = JSON.parse(run([c, '--json']).stdout) as DoctorReport
    expect(ids(j)).toContain('NOY-C001')
  })
  it('--help states the default fail level', () => {
    const r = run(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/DEFAULT: error/)
  })
})
