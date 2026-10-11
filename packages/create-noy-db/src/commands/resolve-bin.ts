/**
 * Locate a dependency's bin in the CALLER's project, without importing the package.
 *
 * `noy-db inspect` reaches `@noy-db/in-devtools-tui` this way (family#114): the TUI
 * depends on `@noy-db/in-devtools`, a satellite, and a core package importing a
 * satellite is the back-edge the one-way law forbids. So the one door REACHES it
 * when it is installed and names it when it is not.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The path of a dependency's bin as installed in the caller's project, or null.
 * Walks `node_modules` by PATH from the cwd upward. Not `require.resolve(pkg +
 * '/package.json')`: a package whose `exports` map omits `./package.json` makes
 * Node refuse that subpath, and most modern packages — this one included — do.
 */
export function resolveBin(pkg: string, binName: string, from = process.cwd()): string | null {
  let dir = from
  for (;;) {
    const manifestPath = join(dir, 'node_modules', ...pkg.split('/'), 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }
        const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
        return rel ? join(dirname(manifestPath), rel) : null
      } catch {
        return null
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
