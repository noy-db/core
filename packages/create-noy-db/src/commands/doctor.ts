/**
 * `noy-db doctor` — readiness checks for a noy-db project (family#116).
 *
 * ## Why a doctor and not a prompt
 *
 * No scaffolder in the surveyed field (Next, Nuxt, Astro, sv, Convex, Clerk,
 * Supabase, Jazz, Better Auth…) asks about recovery, secret handling or tiers
 * at scaffold time. The ones that handle safety well do it the way Django's
 * `check --deploy`, `expo-doctor` and Supabase's advisor do: **stable ids, a
 * level, a fix hint per finding, dev/prod awareness, `--json`, and a default
 * exit threshold stated out loud** — because every lenient default measured
 * (Django exits 0 on warnings, `supabase db lint --fail-on` defaults to none)
 * was a readiness check nobody could gate on.
 *
 * ## Ids
 *
 *   NOY-S0nn  secret        how the secret reaches createNoydb
 *   NOY-R0nn  recovery      can the owner get back in
 *   NOY-T0nn  topology      store, sync, local/cloud posture
 *   NOY-C0nn  capsule       is zero-knowledge actually on
 *   NOY-D0nn  dependencies  what is installed vs what the config imports
 *   NOY-H0nn  hygiene       .env, .gitignore, the things git would leak
 *
 * An id never changes meaning once shipped; a retired check keeps its number.
 *
 * ## What it reads, and with what
 *
 * Everything here runs WITHOUT the user's secret. It reads the config file the
 * project already has (`loadOptionsFromFile`, the same loader `config validate`
 * uses) and, through the config's own store, the vault's public rows: the
 * `_keyring` listing (user ids, roles, slot counts — the keyring FILE is
 * plaintext JSON wrapping ciphertext DEKs) and `_meta/recovery-*`. It never
 * derives a key and never decrypts a record.
 *
 * ⚠️ Two readers hub does not export yet: `loadShamirRecoveryEntries` and
 * `hasRecoveryEnrolled` (only the paper reader is on the root barrel). The
 * Shamir check reads `_meta/recovery-shamir` through the store and parses the
 * documented shape; when hub exports the reader, swap it in (family#92/#94
 * territory — the introspection asymmetry is the same defect).
 *
 * ## Satellite checks
 *
 * A package can contribute checks by exporting `noydbDoctorChecks` (an array of
 * {@link DoctorCheck}) from its ROOT entry. The doctor imports each `@noy-db/*`
 * dependency named in the project's package.json and runs what it finds. A
 * package that exports nothing contributes nothing; a package that fails to
 * import is reported as `NOY-D002`, never thrown.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { NoydbStore } from '@noy-db/hub'
import { loadOptionsFromFile } from './pod/config.js'

export type DoctorLevel = 'error' | 'warn' | 'info'
export type DoctorMode = 'dev' | 'prod'

export interface DoctorFinding {
  /** Stable, e.g. `NOY-R001`. */
  readonly id: string
  readonly level: DoctorLevel
  /** One line: what is wrong. */
  readonly message: string
  /** One line: what to do. Always present — a finding without a fix is a complaint. */
  readonly fix: string
  /** Where it was seen: a config path, a file, a vault. */
  readonly where?: string
}

/** The input a check sees. Nothing here requires a secret. */
export interface DoctorContext {
  readonly mode: DoctorMode
  /** The project directory (where package.json lives). */
  readonly root: string
  /** The config file, when one was found/given. */
  readonly configPath?: string
  /** The loaded options object, untyped on purpose — a check narrows what it reads. */
  readonly options?: Record<string, unknown>
  /** The store from the config, when it has one. */
  readonly store?: NoydbStore
  /** Vault names to inspect. From `--vault`, else the ones the store lists, else none. */
  readonly vaults: readonly string[]
  /** package.json of the project, parsed. */
  readonly manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
}

export interface DoctorCheck {
  readonly id: string
  readonly run: (ctx: DoctorContext) => Promise<readonly DoctorFinding[]> | readonly DoctorFinding[]
}

export interface DoctorReport {
  readonly mode: DoctorMode
  readonly findings: readonly DoctorFinding[]
  readonly counts: Record<DoctorLevel, number>
  /** Which check ids ran, so a `--json` consumer can tell "clean" from "not covered". */
  readonly ran: readonly string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const f = (id: string, level: DoctorLevel, message: string, fix: string, where?: string): DoctorFinding =>
  where === undefined ? { id, level, message, fix } : { id, level, message, fix, where }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** `.gitignore` says it ignores `name` — a plain-line check, not a full gitignore engine. */
function gitignores(root: string, name: string): boolean {
  const p = join(root, '.gitignore')
  if (!existsSync(p)) return false
  return readFileSync(p, 'utf8').split('\n').some((l) => {
    const t = l.trim()
    return t === name || t === `/${name}` || t === `${name}*` || t === '.env*' && name.startsWith('.env')
  })
}

async function listSafely(store: NoydbStore, vault: string, collection: string): Promise<string[] | null> {
  try { return await store.list(vault, collection) } catch { return null }
}

// ─── Built-in checks ──────────────────────────────────────────────────────

const secretChecks: DoctorCheck = {
  id: 'NOY-S',
  run: ({ options, configPath, mode }) => {
    if (!options) return []
    const out: DoctorFinding[] = []
    const secret = options['secret']
    if (typeof secret === 'string' && secret.length > 0) {
      out.push(f('NOY-S001', 'error',
        'the secret is a literal string in the config — it ships with your source',
        'read it from the environment (`secret: process.env.NOYDB_SECRET`) or prompt for it; keep `.env` out of git (see NOY-H001)',
        configPath))
    } else if (secret === undefined && options['getKeyring'] === undefined && options['secretMode'] !== 'managed') {
      out.push(f('NOY-S002', mode === 'prod' ? 'warn' : 'info',
        'no secret and no getKeyring in the config — the app must supply one at runtime',
        'that is fine for an app that prompts; set `secret: process.env.NOYDB_SECRET` for a headless process',
        configPath))
    }
    if (options['secretMode'] === 'managed' && options['sealingKey'] === undefined) {
      out.push(f('NOY-S003', 'error',
        '`secretMode: "managed"` without a `sealingKey` — managed mode has nothing to seal with',
        'pass a sealer from an `@noy-db/at-*` package (`sealingKey: awsKms({...})`), or drop managed mode',
        configPath))
    }
    return out
  },
}

const capsuleChecks: DoctorCheck = {
  id: 'NOY-C',
  run: ({ options, configPath, mode, manifest }) => {
    const out: DoctorFinding[] = []
    if (options?.['encrypt'] === false) {
      out.push(f('NOY-C001', mode === 'prod' ? 'error' : 'warn',
        '`encrypt: false` — records are stored as plaintext; this is not zero-knowledge',
        'remove `encrypt: false` for anything that leaves your machine; it exists for the "see the ciphertext" control and tests',
        configPath))
    }
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    if ('@noy-db/exclave-plain' in deps) {
      out.push(f('NOY-C002', mode === 'prod' ? 'error' : 'warn',
        '`@noy-db/exclave-plain` is installed — when bound (`noy-db:exclave-plain` condition) the vault stores readable rows',
        'keep it to builds whose access control lives in the store (IAM, a DB grant); never in a build that serves untrusted readers'))
    }
    return out
  },
}

const topologyChecks: DoctorCheck = {
  id: 'NOY-T',
  run: ({ options, configPath, mode }) => {
    if (!options) return []
    const out: DoctorFinding[] = []
    const store = options['store']
    const storeName = isRecord(store) && typeof store['name'] === 'string' ? store['name'] : undefined
    if (storeName === 'memory' || storeName === 'memoryStore') {
      out.push(f('NOY-T001', mode === 'prod' ? 'error' : 'info',
        'the store is in-memory — data does not survive a reload',
        'pick a persistent store: `noy-db add @noy-db/to-browser-idb` (browser) or `@noy-db/to-file` (Node)',
        configPath))
    }
    const sync = options['sync']
    const hasSync = Array.isArray(sync) ? sync.length > 0 : sync !== undefined && sync !== null
    if (!hasSync) {
      out.push(f('NOY-T002', 'info',
        'no sync target — this vault lives in one store only; lose it and the data is gone',
        'add a second store as a sync target (a cloud bucket, a file on a USB stick): `noy-db config profiles` shows the shapes',
        configPath))
    }
    return out
  },
}

const recoveryChecks: DoctorCheck = {
  id: 'NOY-R',
  run: async ({ store, vaults, options, mode }) => {
    if (!store || vaults.length === 0) return []
    const out: DoctorFinding[] = []
    for (const vault of vaults) {
      const users = await listSafely(store, vault, '_keyring')
      if (users === null) continue
      if (users.length === 0) continue // not created yet — nothing to say

      // Recovery: paper entries live in _meta/recovery-paper, Shamir in _meta/recovery-shamir.
      // Both are plaintext JSON docs with an `entries` array (the credential is what the
      // user holds; the doc is inert without it) — see hub's with-party/team/recovery.ts.
      const entries = async (id: string): Promise<number> => {
        try {
          const env = await store.get(vault, '_meta', id)
          if (!env) return 0
          const doc = JSON.parse(env._data ?? '') as { entries?: unknown[] }
          return Array.isArray(doc.entries) ? doc.entries.length : 0
        } catch { return 0 }
      }
      const paper = await entries('recovery-paper')
      const shamir = await entries('recovery-shamir')
      if (paper + shamir === 0) {
        out.push(f('NOY-R001', mode === 'prod' ? 'error' : 'warn',
          `vault "${vault}" has no recovery enrolled — a forgotten secret means the data is gone`,
          'enrol one: `noy-db add @noy-db/on-recovery` (printable codes) or `@noy-db/on-shamir` (k-of-n shares), then `db.team.enrollRecovery(...)`',
          vault))
      } else if (shamir === 0 && options?.['secretMode'] === 'managed') {
        out.push(f('NOY-R002', 'error',
          `vault "${vault}" is managed-mode with only paper recovery — managed mode requires a strong (Shamir) profile`,
          'enrol Shamir: `noy-db add @noy-db/on-shamir`', vault))
      }

      // Owners: one owner is one point of total loss.
      let owners = 0
      for (const uid of users) {
        try {
          const env = await store.get(vault, '_keyring', uid)
          const file = env ? (JSON.parse(env._data ?? '') as { role?: string }) : null
          if (file?.role === 'owner') owners++
        } catch { /* unreadable keyring row: not this check's finding */ }
      }
      if (owners === 1 && users.length > 1) {
        out.push(f('NOY-R003', 'info',
          `vault "${vault}" has one owner among ${users.length} users`,
          'a second owner can recover members and rotate keys when the first is unavailable: `noy-db user add <id> owner …`',
          vault))
      }
    }
    return out
  },
}

const dependencyChecks: DoctorCheck = {
  id: 'NOY-D',
  run: ({ root, manifest, configPath }) => {
    const out: DoctorFinding[] = []
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    const hub = deps['@noy-db/hub']
    if (!hub) {
      out.push(f('NOY-D001', 'error', '`@noy-db/hub` is not a dependency of this project', 'add it: `pnpm add @noy-db/hub`', join(root, 'package.json')))
    }
    // Every @noy-db package the config file imports must be installed here, or the
    // app fails at import time in production (the scaffold-symbol class, family#107).
    if (configPath && existsSync(configPath)) {
      const src = readFileSync(configPath, 'utf8')
      const named = new Set([...src.matchAll(/from\s+['"](@noy-db\/[a-z0-9-]+)/g)].map((m) => m[1]!))
      for (const pkg of named) {
        if (!(pkg in deps)) {
          out.push(f('NOY-D002', 'error', `the config imports \`${pkg}\`, which is not in package.json`, `install it: \`pnpm add ${pkg}\``, configPath))
        }
      }
    }
    return out
  },
}

const hygieneChecks: DoctorCheck = {
  id: 'NOY-H',
  run: ({ root }) => {
    const out: DoctorFinding[] = []
    const hasEnv = existsSync(join(root, '.env')) || existsSync(join(root, '.env.local'))
    if (hasEnv && !gitignores(root, '.env')) {
      out.push(f('NOY-H001', 'error', 'a `.env` file exists and `.gitignore` does not ignore it — one `git add .` away from committing secrets',
        'add `.env` and `.env.*` to .gitignore (`noy-db doctor --fix` does this)', join(root, '.gitignore')))
    }
    return out
  },
}

export const BUILTIN_CHECKS: readonly DoctorCheck[] = [secretChecks, capsuleChecks, topologyChecks, recoveryChecks, dependencyChecks, hygieneChecks]

// ─── Satellite checks ─────────────────────────────────────────────────────

/** Import each `@noy-db/*` dependency and collect its `noydbDoctorChecks`, if any. */
async function satelliteChecks(root: string, manifest: DoctorContext['manifest']): Promise<{ checks: DoctorCheck[]; findings: DoctorFinding[] }> {
  const checks: DoctorCheck[] = []
  const findings: DoctorFinding[] = []
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((n) => n.startsWith('@noy-db/') && n !== '@noy-db/hub')
  for (const name of names) {
    const manifestPath = join(root, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(manifestPath)) continue // declared, not installed — NOY-D is about the config, not the lockfile
    try {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports?: unknown; main?: string; module?: string }
      const entry = isRecord(pkg.exports) && '.' in pkg.exports
        ? (() => { const dot = pkg.exports['.']; return typeof dot === 'string' ? dot : isRecord(dot) ? (dot['default'] as string | undefined) ?? (dot['import'] as string | undefined) : undefined })()
        : pkg.module ?? pkg.main
      if (!entry) continue
      const mod = await import(pathToFileURL(join(dirname(manifestPath), entry)).href) as { noydbDoctorChecks?: unknown }
      if (Array.isArray(mod.noydbDoctorChecks)) {
        for (const c of mod.noydbDoctorChecks as DoctorCheck[]) if (c && typeof c.id === 'string' && typeof c.run === 'function') checks.push(c)
      }
    } catch (err) {
      findings.push(f('NOY-D003', 'warn', `\`${name}\` is installed but failed to import: ${(err as Error).message.split('\n')[0]}`, 'reinstall it, or check its peer dependencies', name))
    }
  }
  return { checks, findings }
}

// ─── The run ──────────────────────────────────────────────────────────────

export interface DoctorOptions {
  readonly root?: string
  readonly configPath?: string
  readonly mode?: DoctorMode
  readonly vaults?: readonly string[]
  /** Skip importing satellites (tests, or an untrusted node_modules). */
  readonly noSatellites?: boolean
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const root = resolve(opts.root ?? process.cwd())
  const mode: DoctorMode = opts.mode ?? (process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev')
  const manifestPath = join(root, 'package.json')
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as DoctorContext['manifest']) : {}

  const configPath = opts.configPath ?? ['noydb.config.mjs', 'noydb.config.js'].map((n) => join(root, n)).find((p) => existsSync(p))
  let options: Record<string, unknown> | undefined
  let store: NoydbStore | undefined
  const findings: DoctorFinding[] = []
  if (configPath) {
    try {
      const loaded = await loadOptionsFromFile(configPath)
      if (isRecord(loaded)) {
        options = loaded
        const s = loaded['store']
        if (isRecord(s) && typeof s['get'] === 'function' && typeof s['list'] === 'function') store = s as unknown as NoydbStore
      }
    } catch (err) {
      findings.push(f('NOY-D004', 'error', `the config file did not load: ${(err as Error).message.split('\n')[0]}`, 'run `noy-db config validate <file>` for the details', configPath))
    }
  }

  let vaults: readonly string[] = opts.vaults ?? []
  if (vaults.length === 0 && store && typeof (store as { listVaults?: unknown }).listVaults === 'function') {
    try { vaults = await (store as unknown as { listVaults(): Promise<string[]> }).listVaults() } catch { vaults = [] }
  }

  const ctx: DoctorContext = { mode, root, manifest, vaults, ...(configPath ? { configPath } : {}), ...(options ? { options } : {}), ...(store ? { store } : {}) }
  const sat = opts.noSatellites ? { checks: [], findings: [] } : await satelliteChecks(root, manifest)
  findings.push(...sat.findings)
  const checks = [...BUILTIN_CHECKS, ...sat.checks]
  const ran: string[] = []
  for (const c of checks) {
    ran.push(c.id)
    try { findings.push(...(await c.run(ctx))) }
    catch (err) { findings.push(f('NOY-D005', 'warn', `check ${c.id} threw: ${(err as Error).message.split('\n')[0]}`, 'report this against the package that registered the check')) }
  }
  const counts: Record<DoctorLevel, number> = { error: 0, warn: 0, info: 0 }
  for (const x of findings) counts[x.level]++
  return { mode, findings, counts, ran }
}

// ─── --fix ────────────────────────────────────────────────────────────────

/** The idempotent fixes. Returns what it changed. Only NOY-H001 today. */
export function applyFixes(root: string, report: DoctorReport): string[] {
  const done: string[] = []
  if (report.findings.some((x) => x.id === 'NOY-H001')) {
    const p = join(root, '.gitignore')
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const add = ['.env', '.env.*'].filter((l) => !cur.split('\n').some((x) => x.trim() === l))
    if (add.length) {
      const next = cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + '# noy-db doctor (NOY-H001): never commit secrets\n' + add.join('\n') + '\n'
      writeFileSync(p, next)
      done.push(`.gitignore += ${add.join(', ')}`)
    }
  }
  return done
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const LEVEL_RANK: Record<DoctorLevel, number> = { error: 0, warn: 1, info: 2 }
const ICON: Record<DoctorLevel, string> = { error: '✗', warn: '!', info: '·' }

export function formatReport(r: DoctorReport): string {
  const lines = [`noy-db doctor — mode ${r.mode}, ${r.ran.length} check group(s)`]
  if (r.findings.length === 0) lines.push('  ✓ nothing to report')
  for (const x of [...r.findings].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.id.localeCompare(b.id))) {
    lines.push(`  ${ICON[x.level]} ${x.id}  ${x.message}${x.where ? `  (${x.where})` : ''}`)
    lines.push(`      → ${x.fix}`)
  }
  lines.push(`  ${r.counts.error} error · ${r.counts.warn} warn · ${r.counts.info} info`)
  return lines.join('\n')
}

export async function runDoctor(argv: readonly string[]): Promise<number> {
  const flag = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write([
      'Usage: noy-db doctor [config.mjs] [--mode=dev|prod] [--vault=<name>] [--json] [--fix] [--fail-level=error|warn|info]',
      '',
      'Readiness checks that need no secret. Ids are stable (NOY-S secret · NOY-R recovery · NOY-T topology ·',
      'NOY-C capsule · NOY-D dependencies · NOY-H hygiene); every finding carries a fix.',
      '',
      '  --mode        dev (default unless NODE_ENV=production) or prod — the same finding can be a warn in dev and an error in prod',
      '  --fail-level  exit 1 at or above this level. DEFAULT: error. Pass --fail-level=warn to gate a CI job on warnings too.',
      '  --fix         apply the idempotent fixes (today: gitignore .env)',
      '  --json        machine-readable report',
      '  crypto        the in-memory crypto round-trip (formerly `noy-db verify`)',
    ].join('\n') + '\n')
    return 0
  }
  const configArg = argv.find((a) => !a.startsWith('--'))
  const modeArg = flag('mode')
  if (modeArg !== undefined && modeArg !== 'dev' && modeArg !== 'prod') { process.stderr.write(`--mode must be dev or prod (got ${modeArg})\n`); return 2 }
  const failArg = (flag('fail-level') ?? 'error') as DoctorLevel
  if (!(failArg in LEVEL_RANK)) { process.stderr.write(`--fail-level must be error, warn or info (got ${failArg})\n`); return 2 }
  const vault = flag('vault')

  const report = await doctor({
    ...(configArg ? { configPath: resolve(configArg) } : {}),
    ...(modeArg ? { mode: modeArg } : {}),
    ...(vault ? { vaults: [vault] } : {}),
  })
  let fixed: string[] = []
  if (argv.includes('--fix')) fixed = applyFixes(process.cwd(), report)

  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ ...report, fixed }, null, 2) + '\n')
  else {
    process.stdout.write(formatReport(report) + '\n')
    for (const d of fixed) process.stdout.write(`  fixed: ${d}\n`)
    process.stdout.write(`  (exit is non-zero at --fail-level=${failArg}; default error)\n`)
  }
  const worst = Math.min(...report.findings.map((x) => LEVEL_RANK[x.level]), 99)
  return worst <= LEVEL_RANK[failArg] ? 1 : 0
}
