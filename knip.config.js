// knip configuration (core#55).
//
// Hub's entry list used to be thirteen hand-written globs, and it had
// drifted: `src/kernel/{to,on,at,in,by,ui,with}/index.ts` matched NOTHING
// (those moved to `src/port/*` and `src/with-*/` before 0.7), and eight more
// were flagged redundant. A stale entry list does not fail — it makes knip
// report published code as unused, which is how a report earns 146 rows
// nobody reads.
//
// ⭐ The list is GONE, not corrected, and that is the finding. knip already
// resolves every published subpath from `package.json`'s `exports` map back
// to its source, so all 57 were redundant — measured: deriving them from
// `tsup.entries.mjs` produced 57 "Remove redundant entry pattern" hints, and
// deleting them changes no other number. The only entries worth stating are
// the ones NOT reachable from `exports`.
//
// ⛔ Do not add a published subpath here when you add one to the exports map.
// It is already an entry; listing it a second time is the thing that rotted.

/**
 * Fixtures are addressed BY PATH, never imported — `tsc -p <fixture>` in the
 * bindable-alone and query-tier suites, a child vitest in every conformance
 * kit. knip reasons about the import graph and structurally cannot see a
 * path, so it calls all of them unused.
 *
 * ⛔ This is a STATEMENT, not a suppression, and deleting what it covers
 * would remove the only thing giving those kits the ability to fail (#46).
 * The suites that USE them are ordinary entries and stay checked.
 */
const PATH_ADDRESSED_FIXTURES = '**/__tests__/fixtures/**'

/**
 * `@vitest/coverage-v8` is the ONE row deliberately left red (#55 step 4).
 *
 * `vitest.config.ts` sets `coverage.provider: 'v8'` and the root script
 * `test:ci` is `turbo run test -- --coverage`, but the package is in no
 * manifest and no lockfile — and `test:ci` is invoked by no workflow. So the
 * coverage path cannot have run since it was written. It resolves EITHER by
 * installing the provider or by deleting the dead script, and that is a
 * decision, not a config statement — suppressing it here would convert a real
 * finding into silence, which is the defect #55 was filed about.
 *
 * ⛔ Do not add it to `ignoreDependencies` to make the gate green.
 */

export default {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  rules: {
    // ⛔ OFF, not "no duplicates found" — both instances in this tree are the
    // same deliberate idiom and knip cannot tell it from a mistake:
    //   `channelMesh` / `byPeer`            — one factory, two PUBLISHED names
    //                                         (by-tabs binds one, by-peer the
    //                                         other); both are documented and
    //                                         both are in the surface golden.
    //   `COST_BYTE_V1` / `CURRENT_COST_BYTE` — a versioned constant plus the
    //                                         `CURRENT_` alias every caller
    //                                         uses, which is what makes the
    //                                         next cost byte a one-line move.
    // Deleting either alias is a breaking change for the first and a
    // find-and-replace across the classify cluster for the second.
    duplicates: 'off',
  },
  // System binaries a script shells out to. Not npm packages, so there is no
  // manifest row that could satisfy knip.
  ignoreBinaries: ['tar'],
  // `@seam`   — exported for a boundary, with no importer BY DESIGN (the tag
  //             sits on the declaration and carries the reason).
  // `@public`  — published API: a consumer imports it, which knip cannot see
  //             because the import is not in this repo.
  tags: ['-seam', '-public'],
  workspaces: {
    '.': {
      entry: ['scripts/*.mjs', 'scripts/__tests__/**/*.test.ts'],
      ignore: [],
    },
    'packages/create-noy-db': {
      ignore: ['templates/**'],
    },
    'packages/hub': {
      // NOT reachable from the exports map, so each has to be said:
      entry: [
        'scripts/*.mjs',
        '__tests__/**/*.test-d.ts',
        // Side-effect installers: reachable only as bare imports (#1458).
        'src/**/active.ts',
      ],
      ignore: [PATH_ADDRESSED_FIXTURES],
    },
    'packages/in-nuxt': {
      // Both are used, and neither use is an import:
      //   `@nuxt/schema` — only ever named by `declare module '@nuxt/schema'`
      //                    (src/module.ts) and by tsup's `external` list.
      //   `happy-dom`    — named as a STRING in `environmentMatchGlobs`.
      // `scripts/check-test-env-deps.mjs` exists precisely because this second
      // shape is invisible to both an import scan and a config grep.
      ignoreDependencies: ['@nuxt/schema', 'happy-dom'],
      // Same class as the fixtures: a file that exists for a COMPILER PROGRAM
      // rather than for the import graph. `vue-shims.d.ts` is what lets `tsc`
      // resolve the `.vue` SFCs the tests mount (core#40) — nothing imports
      // it, and the shipped code deliberately never imports an SFC as a
      // module. Deleting it makes every SFC import a TS2307.
      ignore: ['__tests__/vue-shims.d.ts'],
    },
    'packages/in-rest': {
      // `h3` is an OPTIONAL PEER this package adapts to without importing —
      // the Nitro adapter returns a Fetch `Response` and never touches h3's
      // API. It is named in tsup's `external` list and in `peerDependencies`;
      // the devDep is what makes the adapter's tests typecheck.
      ignoreDependencies: ['h3'],
    },
    'test-harnesses/benchmarks': {
      // ⚠️ Both harnesses reach hub by RELATIVE PATH into `packages/hub/src`,
      // never by specifier, so knip sees no import. The manifest row is not
      // decoration: it is what orders hub ahead of the harness in turbo's
      // graph. Removing it is the exact mistake the to-memory relocation made
      // — "nothing imports it" is not the same question as "nothing needs it"
      // when the importers use a path.
      ignoreDependencies: ['@noy-db/hub'],
    },
    'test-harnesses/simulation-filesystem': {
      ignoreDependencies: ['@noy-db/hub'],
    },
    // The fixtures moved with the kits into ports (one level deeper: __tests__/<port>/fixtures).
    'packages/ports': { ignore: ['**/__tests__/*/fixtures/**'] },
  },
}
