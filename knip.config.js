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

export default {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  tags: ['-seam'],
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
      // Same class as the fixtures: a file that exists for a COMPILER PROGRAM
      // rather than for the import graph. `vue-shims.d.ts` is what lets `tsc`
      // resolve the `.vue` SFCs the tests mount (core#40) — nothing imports
      // it, and the shipped code deliberately never imports an SFC as a
      // module. Deleting it makes every SFC import a TS2307.
      ignore: ['__tests__/vue-shims.d.ts'],
    },
    'packages/test-adapter-conformance': { ignore: [PATH_ADDRESSED_FIXTURES] },
    'packages/test-ceremony-conformance': { ignore: [PATH_ADDRESSED_FIXTURES] },
    'packages/test-format-conformance': { ignore: [PATH_ADDRESSED_FIXTURES] },
    'packages/test-mesh-conformance': { ignore: [PATH_ADDRESSED_FIXTURES] },
  },
}
