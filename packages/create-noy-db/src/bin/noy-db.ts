#!/usr/bin/env node
/**
 * The `noy-db` bin — THE ONE DOOR after `npm create noy-db` (family#114).
 *
 * Until 2026-10-11 a newcomer met three bins from three packages: this one
 * (`add`, `verify`, `rotate`, `backup`), `@noy-db/cli`'s `noydb` (`inspect`,
 * `verify`, `describe`, `config`, `monitor`) and `@noy-db/in-devtools-tui`'s
 * `noydb-inspect`. Two of them had a `verify` that meant different things. The
 * docs carried a "which binary is which" table instead of there being one
 * binary. This file is that one binary; `@noy-db/cli` is now a shim that
 * redirects here.
 *
 *   noy-db add <collection>                   scaffold a store + page
 *   noy-db user add <id> <role> [options]     grant a user (was `add user`)
 *   noy-db user rotate [options]              rotate DEKs (was `rotate`)
 *   noy-db backup <target> [options]          dump a vault to a file
 *   noy-db doctor [config] [--mode] [--fix]  readiness checks with stable ids (family#116)
 *   noy-db doctor crypto                      in-memory crypto round-trip (was `verify`)
 *   noy-db pod inspect <file.noydb>           bundle header, no secret
 *   noy-db pod verify  <file.noydb>           bundle integrity, no secret
 *   noy-db describe <file.noydb> [options]    YAML/JSON schema audit
 *   noy-db config validate <file>             sanity-check a NoydbOptions file
 *   noy-db config scaffold [--profile=<id>]   topology skeleton to stdout, .env to stderr
 *   noy-db config profiles                    list the ten profiles
 *   noy-db monitor <file> [--interval=ms]     live store metrics (store must be metered)
 *   noy-db inspect <file> --vault=<v> […]     the TUI inspector (reached lazily, see below)
 *
 * ## Why `inspect` SHELLS OUT instead of importing the TUI
 *
 * The TUI (`@noy-db/in-devtools-tui`) depends on `@noy-db/in-devtools`, a
 * satellite in `noy-db/in`. A core package importing a satellite is the
 * back-edge the one-way law forbids. So this door REACHES the TUI when it is
 * installed and names `noy-db add in-devtools-tui` when it is not — the same
 * shape `monitor` uses for `to-meter`. One door, no back-edge.
 *
 * ## Dispatcher design
 *
 * Deliberately flat: read argv, pick a handler, pass the rest. Each
 * subcommand's argv parser lives next to the subcommand so the pure functions
 * stay testable in isolation. The old spellings (`add user`, `rotate`,
 * `verify`) keep working for one line, printing the new one.
 *
 * ## Secret handling invariants
 *
 * Every subcommand that unlocks a vault goes through `defaultReadSecret`
 * (`commands/shared.ts`): @clack `password()` so nothing echoes, the value is
 * never logged, and the Noydb instance closes in a `finally` so the KEK is
 * cleared on the way out.
 */

import { spawnSync } from 'node:child_process'
import pc from 'picocolors'
import { resolveBin } from '../commands/resolve-bin.js'
import { addCollection } from '../commands/add.js'
import { verifyIntegrity } from '../commands/verify.js'
import { rotate, type RotateOptions } from '../commands/rotate.js'
import { addUser, type AddUserOptions } from '../commands/add-user.js'
import { backup } from '../commands/backup.js'
import { assertRole, parseCollectionList } from '../commands/shared.js'
import { runInspect as runPodInspect } from '../commands/pod/inspect.js'
import { runVerify as runPodVerify } from '../commands/pod/verify.js'
import { runDescribe } from '../commands/pod/describe.js'
import { runConfigValidate, runConfigScaffold, runConfigProfiles } from '../commands/pod/config.js'
import { runMonitor } from '../commands/pod/monitor.js'
import { runDoctor } from '../commands/doctor.js'
import { runAddPackage } from '../commands/add-package.js'

const HELP = `Usage: noy-db <command> [args]

Project
  add <collection>                             Scaffold a new collection store + page
  add <@noy-db/package> [--dev] [--dry-run]    Install a package, wire it, print the trust boundary
  add --list [to|in|on|as|by|at]               The landscape — every package, by layer
  user add <userId> <role> [options]           Grant a new user access to a vault
  user rotate [options]                        Rotate DEKs for a vault
  backup <target> [options]                    Dump a vault to a file
  doctor [config] [--mode=prod] [--fix]        Readiness checks: secret, recovery, topology, capsule, deps, hygiene
  doctor crypto                                In-memory crypto round-trip check

Pods (.noydb files)
  pod inspect <file.noydb>                     Print the bundle header (no secret)
  pod verify  <file.noydb>                     Verify bundle integrity (no secret)
  describe <file.noydb> [options]              YAML/JSON schema audit (needs the secret)

Configuration
  config validate <file.js|mjs>                Sanity-check a NoydbOptions file
  config scaffold [--profile=<id>]             Topology skeleton → stdout, .env template → stderr
  config profiles                              List the ten topology profiles

Running
  monitor <file.js|mjs> [--interval=ms]        Live store metrics (the store must be metered)
  inspect <file.js|mjs> --vault=<name> [...]   Terminal inspector (installs on demand)

Common options for user add / user rotate / backup:
  --dir <path>               Data directory (file adapter). Default: ./data
  --vault <name>             Vault (tenant) name. Required.
  --user <id>                Your user id in the vault. Required.
  --collections <list>       rotate: invoices,clients · user add: invoices:rw,clients:ro

Examples:
  noy-db add invoices
  noy-db user add ann operator --dir ./data --vault demo-co --user owner-alice --collections invoices:rw
  noy-db config profiles
  noy-db config scaffold --profile=B > noydb.config.mjs
  noy-db doctor --mode=prod --fail-level=warn

New project? \`npm create noy-db@latest\`.
`

/** One line, once, when an old spelling is used. The old spelling still works. */
function renamed(from: string, to: string): void {
  process.stderr.write(`${pc.dim(`(\`noy-db ${from}\` is now \`noy-db ${to}\`)`)}\n`)
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv

  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP)
      return

    case 'add': {
      if (rest[0] === 'user') { renamed('add user', 'user add'); await runAddUser(rest.slice(1)); return }
      // A @noy-db package, a prefixed name (to-aws-s3), or --list → the landscape verb.
      // A bare word (invoices) → scaffold a collection, as before.
      const first = rest[0]
      if (rest.some((a) => a === '--list' || a === '--help') || (first && /^(@noy-db\/|to-|in-|on-|as-|by-|at-)/.test(first))) {
        process.exit(await runAddPackage(rest))
      }
      await runAdd(rest)
      return
    }

    case 'user': {
      const [sub, ...subRest] = rest
      if (sub === 'add') { await runAddUser(subRest); return }
      if (sub === 'rotate') { await runRotate(subRest); return }
      fail(`\`noy-db user\` takes \`add\` or \`rotate\``)
      return
    }

    case 'rotate':
      renamed('rotate', 'user rotate')
      await runRotate(rest)
      return

    case 'backup':
      await runBackup(rest)
      return

    case 'verify':
      renamed('verify', 'doctor crypto')
      await runCryptoCheck()
      return

    case 'doctor': {
      if (rest[0] === 'crypto') { await runCryptoCheck(); return }
      process.exit(await runDoctor(rest))
      return
    }

    case 'pod': {
      const [sub, ...subRest] = rest
      if (sub === 'inspect') process.exit(await runPodInspect(subRest))
      if (sub === 'verify') process.exit(await runPodVerify(subRest))
      fail(`\`noy-db pod\` takes \`inspect\` or \`verify\``)
      return
    }

    case 'describe':
      process.exit(await runDescribe(rest))
      return

    case 'config': {
      const [sub, ...subRest] = rest
      if (sub === 'validate') process.exit(await runConfigValidate(subRest))
      if (sub === 'scaffold') process.exit(await runConfigScaffold(subRest))
      if (sub === 'profiles') process.exit(runConfigProfiles())
      fail(`\`noy-db config\` takes \`validate\`, \`scaffold\` or \`profiles\``)
      return
    }

    case 'monitor':
      process.exit(await runMonitor(rest))
      return

    case 'inspect':
      process.exit(runTuiInspect(rest))
      return

    default:
      process.stderr.write(`${pc.red('error:')} unknown command '${command}'\n\n${HELP}`)
      process.exit(2)
  }
}

function fail(message: string): never {
  process.stderr.write(`${pc.red('error:')} ${message}\n`)
  process.exit(2)
}

// ─── `inspect` — reach the TUI without importing it ────────────────────

/**
 * Resolve `noydb-inspect` from the caller's project and exec it. We resolve
 * rather than `npx` so an installed TUI is used as-is and an absent one is
 * named precisely, instead of npx silently downloading something at a version
 * nobody chose.
 */
export function runTuiInspect(args: readonly string[]): number {
  const bin = resolveBin('@noy-db/in-devtools-tui', 'noydb-inspect')
  if (!bin) {
    process.stderr.write(
      `${pc.red('error:')} the terminal inspector is not installed in this project.\n\n` +
        `  ${pc.bold('pnpm add -D @noy-db/in-devtools-tui')}   ${pc.dim('(or npm/yarn/bun)')}\n\n` +
        `then re-run \`noy-db inspect\`. It needs a config file, --vault=<name>, and a secret (--secret or NOYDB_SECRET).\n`,
    )
    return 2
  }
  const r = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' })
  return r.status ?? 1
}


// ─── `add` ──────────────────────────────────────────────────────────────

async function runAdd(args: string[]): Promise<void> {
  const first = args[0]
  if (!first) {
    process.stderr.write(
      `${pc.red('error:')} \`noy-db add\` requires a collection name\n\n` +
        `Examples:\n  noy-db add invoices\n  noy-db user add alice operator ...\n`,
    )
    process.exit(2)
  }
  try {
    const result = await addCollection({ name: first })
    process.stdout.write(`${pc.green('✔')} Created:\n`)
    for (const file of result.files) {
      process.stdout.write(`  ${pc.dim('→')} ${file}\n`)
    }
    process.stdout.write(
      `\nNext: visit ${pc.cyan(`/${first}`)} in your dev server, then edit ${pc.bold(`app/stores/${first}.ts`)} to match your domain.\n`,
    )
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── `doctor crypto` ───────────────────────────────────────────────────

async function runCryptoCheck(): Promise<void> {
  process.stdout.write(`${pc.dim('▸ Running noy-db crypto round-trip…')}\n`)
  const result = await verifyIntegrity()
  if (result.ok) {
    process.stdout.write(`${pc.green('✔')} ${result.message} ${pc.dim(`(${result.durationMs}ms)`)}\n`)
    return
  }
  process.stderr.write(`${pc.red('✘')} ${result.message} ${pc.dim(`(${result.durationMs}ms)`)}\n`)
  process.exit(1)
}

// ─── `user add` ────────────────────────────────────────────────────────

async function runAddUser(args: string[]): Promise<void> {
  const userId = args[0]
  const roleInput = args[1]
  if (!userId || !roleInput) {
    process.stderr.write(
      `${pc.red('error:')} \`noy-db user add\` requires <userId> <role>\n\n` +
        `Example: noy-db user add ann operator --dir ./data --vault demo-co --user owner-alice --collections invoices:rw\n`,
    )
    process.exit(2)
  }

  let role
  try {
    role = assertRole(roleInput)
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(2)
    return
  }

  const flags = parseFlags(args.slice(2))
  const dir = flags.dir ?? './data'
  const vault = requireFlag(flags, 'vault')
  const callerUser = requireFlag(flags, 'user')

  const permissions = parsePermissions(flags['collections'])

  const opts: AddUserOptions = {
    dir,
    vault,
    callerUser,
    newUserId: userId,
    role,
  }
  if (flags['display-name']) opts.newUserDisplayName = flags['display-name']
  if (permissions) opts.permissions = permissions

  try {
    const result = await addUser(opts)
    process.stdout.write(
      `${pc.green('✔')} Granted ${pc.bold(result.role)} access to ${pc.cyan(result.userId)} in vault ${pc.cyan(vault)}.\n`,
    )
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── `user rotate` ─────────────────────────────────────────────────────

async function runRotate(args: string[]): Promise<void> {
  const flags = parseFlags(args)
  const dir = flags.dir ?? './data'
  const vault = requireFlag(flags, 'vault')
  const user = requireFlag(flags, 'user')

  const opts: RotateOptions = { dir, vault, user }
  const collections = parseCollectionList(flags['collections'])
  if (collections) opts.collections = collections

  try {
    const result = await rotate(opts)
    process.stdout.write(
      `${pc.green('✔')} Rotated ${pc.bold(String(result.rotated.length))} collection(s) in ${pc.cyan(vault)}:\n`,
    )
    for (const name of result.rotated) {
      process.stdout.write(`  ${pc.dim('→')} ${name}\n`)
    }
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── `backup` ──────────────────────────────────────────────────────────

async function runBackup(args: string[]): Promise<void> {
  const target = args[0]
  if (!target) {
    process.stderr.write(
      `${pc.red('error:')} \`noy-db backup\` requires a target path\n\n` +
        `Example: noy-db backup ./backups/demo.json --dir ./data --vault demo-co --user owner-alice\n`,
    )
    process.exit(2)
  }

  const flags = parseFlags(args.slice(1))
  const dir = flags.dir ?? './data'
  const vault = requireFlag(flags, 'vault')
  const user = requireFlag(flags, 'user')

  try {
    const result = await backup({ dir, vault, user, target })
    process.stdout.write(
      `${pc.green('✔')} Wrote backup: ${pc.cyan(result.path)} ${pc.dim(`(${result.bytes} bytes)`)}\n`,
    )
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── Shared argv helpers ───────────────────────────────────────────────

/**
 * Parse a sequence of `--key value` flag pairs into a record. Boolean flags
 * (`--flag` with no value) become `"true"`. Positionals are peeled by the
 * caller before this sees the args.
 */
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg || !arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]
  if (!value) {
    process.stderr.write(`${pc.red('error:')} missing required flag --${name}\n`)
    process.exit(2)
  }
  return value
}

/** `--collections invoices:rw,clients:ro` → `{ invoices: 'rw', clients: 'ro' }`, or null when empty. */
function parsePermissions(input: string | undefined): Record<string, 'rw' | 'ro'> | null {
  if (!input) return null
  const out: Record<string, 'rw' | 'ro'> = {}
  for (const pair of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, mode] = pair.split(':')
    if (!name || !mode || (mode !== 'rw' && mode !== 'ro')) {
      throw new Error(`Invalid --collections entry "${pair}" — expected "name:rw" or "name:ro"`)
    }
    out[name] = mode
  }
  return Object.keys(out).length > 0 ? out : null
}

main().catch((err: unknown) => {
  process.stderr.write(`${pc.red('fatal:')} ${(err as Error).message}\n`)
  process.exit(1)
})
