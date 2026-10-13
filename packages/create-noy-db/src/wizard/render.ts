/**
 * Template loader and renderer.
 *
 * Templates live under `packages/create-noy-db/templates/<template-name>/`
 * as a literal directory tree. Files are read verbatim from disk; the
 * renderer walks the tree, substitutes a small set of placeholder tokens,
 * and writes the result to the target directory.
 *
 * The placeholder syntax is intentionally minimal: `{{TOKEN}}` (uppercase,
 * no spaces, no nested expressions). This avoids dragging in handlebars
 * or any templating library, keeps the bundle small, and means there's
 * exactly one rule to learn when authoring a template.
 *
 * Files whose names start with `_` are renamed to `.` on copy. This is
 * how we ship `_gitignore` (`.gitignore`) without npm trying to interpret
 * it as part of the package contents.
 */

import { promises as fs, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Tokens the renderer recognizes. Authoring rule for templates: every
 * placeholder must be a member of this set, otherwise template authors
 * will hit silent no-ops at render time.
 */
export interface RenderTokens {
  /** The user-supplied project name. Used for `package.json#name` etc. */
  PROJECT_NAME: string
  /** The chosen adapter (browser/file/memory). */
  ADAPTER: string
  /**
   * The npm package that adapter resolves to, for prose: `@noy-db/to-browser-idb`,
   * `@noy-db/to-file`, or `@noy-db/hub` (memory is hub's built-in `memoryStore`).
   * Until 2026-10-11 the Nuxt README rendered `@noy-db/{{ADAPTER}}` → `@noy-db/browser`,
   * a package that does not exist (family#108).
   */
  ADAPTER_PACKAGE: string
  /** "true" or "false" — written into `nuxt.config.ts` for `noydb.devtools`. */
  DEVTOOLS: string
  /** A literal `[...]` block of seed records, or `[]` if `sampleData` is false. */
  SEED_INVOICES: string
  /**
   * The version every `@noy-db/*` dependency (and the template's own
   * `create-noy-db` devDep) is pinned to, written as `^{{NOYDB_VERSION}}`
   * in template `package.json`s. Filled from this package's own version
   * (see `ownVersion()`), so scaffolded apps always depend on the family
   * line the wizard itself shipped with (#703).
   *
   * ⚠️ That is correct ONLY while this package shares the family's lockstep
   * line. It stopped sharing it once — the release normaliser filtered
   * members by the `@noy-db/` prefix and this is the one unscoped package —
   * and every scaffolded app then pinned `^0.3.4` against a `0.7.x` line
   * (#1313). The normaliser now tests workspace membership, and
   * `__tests__/pins-resolve.test.ts` asserts the REAL token value equals the
   * workspace version of every package the templates pin.
   */
  NOYDB_VERSION: string
  /**
   * The version every `@noy-db/in-*` dependency is pinned to, written as
   * `^{{NOYDB_IN_VERSION}}`. The framework bindings left the core monorepo
   * for `noy-db/in` on 2026-09-21 and version on their OWN line, so
   * `ownVersion()` no longer speaks for them. Filled from
   * `NOYDB_IN_VERSION` below.
   */
  NOYDB_IN_VERSION: string
}

/**
 * The published `noy-db/in` line the templates pin. Not derivable from this
 * workspace — the packages are not in it — so it is a constant, bumped when
 * `noy-db/in` cuts. `__tests__/pins-resolve.test.ts`'s registry test
 * (`NOYDB_SCAFFOLD_INSTALL=1`) is what proves the value resolves on npm.
 */
// ⚠️ Was '0.8.0' through create-noy-db 0.9.0, whose scaffolds paired hub 0.9.0
// with in-* 0.8.0 (peer hub ^0.8.0) — an ERESOLVE under npm's strict peers.
// Set to the in line cut in the SAME family cut as this hub.
//
// ⚠️ 0.10.0-pre.2 (ruled 2026-10-13). ⛔ THE WINDOW IS A FEW RELEASES, NOT
// MINUTES — the older note here said "minutes after core", which understates
// it: `in` is SIXTH in the family publish order, after core, to, as, on and at.
// A scaffold created between core's publish and `in`'s will fail to install,
// and the family root closes the window within the same session.
//
// ⛔ NOTHING IN THIS REPO CAN CATCH A WRONG VALUE HERE. `pins-resolve.test.ts`
// says so itself: for an `@noy-db/in-*` dep the structural gate can only check
// the token was applied, and only the `NOYDB_SCAFFOLD_INSTALL=1` registry gate
// proves the version exists on npm. So a stale or premature value passes every
// default run — which is how the 0.8.0/0.9.0 pairing above shipped.
export const NOYDB_IN_VERSION = '0.10.0-pre.2'

/** The package a wizard adapter choice names in generated prose (see `ADAPTER_PACKAGE`). */
export const ADAPTER_PACKAGES = {
  browser: '@noy-db/to-browser-idb',
  file: '@noy-db/to-file',
  memory: '@noy-db/hub',
} as const

/**
 * Walks `src` recursively and copies every file into `dest`, substituting
 * `{{TOKEN}}` placeholders along the way.
 *
 * Returns the relative paths of every file written, sorted alphabetically.
 * Tests use this to assert that the expected file set was produced without
 * having to walk `dest` themselves.
 *
 * The function is intentionally synchronous-feeling (uses `await` inside
 * a depth-first walk) so the order of writes is deterministic — easier
 * to reason about when something fails halfway through.
 */
export async function renderTemplate(
  src: string,
  dest: string,
  tokens: RenderTokens,
): Promise<string[]> {
  const written: string[] = []
  await walk(src, dest, '', tokens, written)
  written.sort()
  return written
}

async function walk(
  srcRoot: string,
  destRoot: string,
  rel: string,
  tokens: RenderTokens,
  written: string[],
): Promise<void> {
  const srcDir = path.join(srcRoot, rel)
  const entries = await fs.readdir(srcDir, { withFileTypes: true })

  for (const entry of entries) {
    const srcEntry = path.join(srcDir, entry.name)
    // _gitignore → .gitignore, _npmrc → .npmrc, etc.
    // npm strips files starting with `.` from the published tarball, so
    // shipping them as `_<name>` is the standard workaround.
    const destName = entry.name.startsWith('_')
      ? `.${entry.name.slice(1)}`
      : entry.name
    const destRel = rel ? path.join(rel, destName) : destName
    const destEntry = path.join(destRoot, destRel)

    if (entry.isDirectory()) {
      await fs.mkdir(destEntry, { recursive: true })
      await walk(srcRoot, destRoot, path.join(rel, entry.name), tokens, written)
      continue
    }

    const raw = await fs.readFile(srcEntry, 'utf8')
    const rendered = applyTokens(raw, tokens)
    await fs.mkdir(path.dirname(destEntry), { recursive: true })
    await fs.writeFile(destEntry, rendered, 'utf8')
    written.push(destRel)
  }
}

/**
 * Substitutes every `{{KEY}}` in `input` with the corresponding value
 * from `tokens`. Unknown keys are left untouched (so the user can spot
 * them visually in the generated output if a template author makes a
 * typo). Empty values are allowed.
 */
export function applyTokens(input: string, tokens: RenderTokens): string {
  const bag = tokens as unknown as Record<string, string>
  return input.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = bag[key]
    return value === undefined ? match : value
  })
}

/**
 * Resolves the absolute path of a template directory shipped inside the
 * package. The package layout is:
 *
 *   create-noy-db/
 *     dist/
 *       index.js           ← the LIBRARY entry lives here
 *       bin/create.js      ← the BINS live one level deeper
 *     templates/
 *       nuxt-default/      ← we want to point at this
 *
 * ⛔ THE DEPTH IS NOT FIXED, so a hardcoded `'..', '..'` cannot be right for
 * both. This file is bundled (tsup, `splitting: false`, three entries), so
 * `render.ts` is INLINED into each entry and `import.meta.url` is the
 * ENTRY's path, never this source file's. From `dist/bin/create.js` two
 * levels up is the package root; from `dist/index.js` it is the package's
 * PARENT — `node_modules/`, or `packages/` in this monorepo. family#216:
 * `ownVersion()` therefore read `node_modules/package.json` (ENOENT) and
 * `templateDir()` pointed outside the package, for every LIBRARY caller
 * (`bundledCatalog()`, `describeBundle()`); the bins were fine, which is
 * exactly why it shipped. Latent since the 0.8 base, not a new regression —
 * family#124 only widened it by making `describe` call `ownVersion()`.
 *
 * ⭐ So find the root by WALKING UP to our own `package.json` instead of
 * counting levels. That is correct from any entry depth, from `src/` under
 * vitest (no build), and from a global install.
 */
export function templateDir(name: string): string {
  return path.join(packageRoot(), 'templates', name)
}

let cachedPackageRoot: string | undefined

/**
 * This package's own root: the nearest ancestor holding a `package.json`
 * whose `name` is `create-noy-db`.
 *
 * ⚠ The NAME check is load-bearing, not belt-and-braces. "Nearest
 * `package.json`" happens to work from today's two entry depths, but the
 * scaffolds under `templates/<name>/` carry their own manifests, so
 * "nearest" is only safe while nothing resolves from below `templates/`.
 * Matching the name also means a vendored `dist/` fails with a sentence
 * instead of silently resolving to somebody else's package root.
 */
function packageRoot(): string {
  if (cachedPackageRoot !== undefined) return cachedPackageRoot
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = path.join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
        if (pkg.name === 'create-noy-db') {
          cachedPackageRoot = dir
          return dir
        }
      } catch {
        // An unreadable or malformed manifest is not ours to diagnose — keep walking.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(
        `create-noy-db: could not locate its own package root by walking up from ${path.dirname(fileURLToPath(import.meta.url))} — no ancestor holds a package.json named "create-noy-db"`,
      )
    }
    dir = parent
  }
}

let cachedOwnVersion: string | undefined

/**
 * This package's own version, read from its `package.json` (a sibling of
 * `dist/` and `templates/`, found by {@link packageRoot} — see the depth
 * warning there). The wizard versions in lockstep with the `@noy-db/*`
 * family, so this is the value `{{NOYDB_VERSION}}` resolves to at scaffold
 * time.
 */
export async function ownVersion(): Promise<string> {
  if (cachedOwnVersion === undefined) {
    const raw = await fs.readFile(path.join(packageRoot(), 'package.json'), 'utf8')
    cachedOwnVersion = (JSON.parse(raw) as { version: string }).version
  }
  return cachedOwnVersion
}
