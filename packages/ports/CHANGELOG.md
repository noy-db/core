# @noy-db/ports

## 0.9.0-pre.2

Lockstep bump to 0.9.0-pre.2; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.2 for the line's notes.

## 0.9.0-pre.1

Lockstep bump to 0.9.0-pre.1; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.1 for the line's notes.

## 0.9.0-pre.0

Initial release — the six conformance kits consolidated into one package with one subpath per hub port (`@noy-db/ports/to`, `/as`, `/at`, `/on`, `/by`, `/capsule`). Exported function names are unchanged from `@noy-db/test-adapter-conformance`, `test-format-conformance`, `test-sealer-conformance`, `test-ceremony-conformance`, `test-mesh-conformance` and `test-capsule-conformance`, which now re-export from here and are deprecated in favour of it. **Not a break for a consumer of those names:** function names and signatures are unchanged and the peers are the same (`@noy-db/hub`, `vitest`); only the import specifier moved, and the old specifiers keep working through the shims. Six self-contained entries, each resolved and called by `__tests__/subpaths.test.ts` through the package's own `exports` map.
