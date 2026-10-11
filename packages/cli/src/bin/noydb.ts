#!/usr/bin/env node
/**
 * `noydb` — a REDIRECT, since 2026-10-11 (family#114).
 *
 * Every command this bin carried (`inspect`, `verify`, `describe`, `config`,
 * `monitor`) lives in `create-noy-db`'s `noy-db` bin, the one door after
 * `npm create noy-db`. This file maps the old spelling to the new one, prints
 * it once, and execs it when `noy-db` is installed beside this package; when
 * it is not, it says what to install. It carries no command logic of its own.
 *
 * `@noy-db/cli` is deprecated on npm at the stable 0.10.0 (not the pre),
 * pointing at `create-noy-db`.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

declare const __CLI_VERSION__: string
const VERSION = __CLI_VERSION__

/** old `noydb` argv → new `noy-db` argv. */
export function translate(argv: readonly string[]): string[] {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'inspect': return ['pod', 'inspect', ...rest]
    case 'verify':  return ['pod', 'verify', ...rest]
    default:        return [...argv]
  }
}

/**
 * The path of `create-noy-db`'s `noy-db` bin as installed in the caller's project, or null.
 * Walks `node_modules` by PATH rather than `require.resolve('create-noy-db/package.json')`:
 * that package's `exports` map lists only `.`, so Node refuses the subpath.
 */
function findNoyDbBin(): string | null {
  let dir = process.cwd()
  for (;;) {
    const manifestPath = join(dir, 'node_modules', 'create-noy-db', 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: Record<string, string> }
      const rel = manifest.bin?.['noy-db']
      return rel ? join(dirname(manifestPath), rel) : null
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function main(argv: readonly string[]): number {
  const [cmd] = argv
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(VERSION + '\n')
    return 0
  }
  const next = translate(argv)
  process.stderr.write(`(\`noydb${argv.length ? ' ' + argv.join(' ') : ''}\` is now \`noy-db ${next.join(' ')}\` — @noy-db/cli only redirects)\n`)

  const bin = findNoyDbBin()
  if (!bin) {
    process.stderr.write('create-noy-db is not installed here: `pnpm add -D create-noy-db` and run `noy-db` directly.\n')
    return 2
  }
  const r = spawnSync(process.execPath, [bin, ...next], { stdio: 'inherit' })
  return r.status ?? 1
}

process.exit(main(process.argv.slice(2)))
