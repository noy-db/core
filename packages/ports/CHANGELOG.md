# @noy-db/ports

## 0.10.0-pre.2

**The kit asks three questions it never asked, and each one caught a shipped store.**

- **A record id may contain a NUL**, and must round-trip through `put`, `get` AND `list`. Hub emits
  these — `resolveSequenceKey` joins a partition as `${name}\x00${parts}` — so a store that refused
  the byte could not hold a partitioned sequence at all. `to-file` failed it (family#174).
- **Ids are case-distinct**: `put('Abc')` and `put('abc')` are two records, **or the store refuses
  the second write**. A refusal is conformant, the same shape as the `..` case. `to-mysql` failed it
  on MySQL 8.4's default collation, and `to-file` failed it on any case-folding filesystem
  (family#177).
- **The classify group's primitives are all exercised**, and the tag table is asserted against the
  call table. On its first run that found `deriveDeterministicKey` — a real primitive the suite never
  called, so a capsule could refuse one function while its sibling silently worked (family#168).
- `runCapsuleConformance` now checks `capabilities()` against behaviour group by group; it never
  called `assertGroupRefuses`, so the guarantee ran only against the capsule that refuses nothing
  (family#172).
- New exports: `assertPrimitiveTagsCovered`, `groupWithoutPrimitives`, `groupVerdict`,
  `groupMemberNames`, `OPTIONAL_GROUPS`. ⛔ The kit's published `CapsuleGroup` was missing
  `per-record-keys`; the drift check now runs both directions over it (family#172).

## 0.10.0-pre.1

Lockstep bump to 0.10.0-pre.1; no package-level change in this release. See `@noy-db/hub` 0.10.0-pre.1 for the line's notes.

## 0.10.0-pre.0

Lockstep bump to 0.10.0-pre.0; no package-level change in this release. See `@noy-db/hub` 0.10.0-pre.0 for the line's notes.

## 0.9.0

Lockstep bump to 0.9.0; no package-level change in this release. See `@noy-db/hub` 0.9.0 for the line's notes.

## 0.9.0-pre.2

Lockstep bump to 0.9.0-pre.2; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.2 for the line's notes.

## 0.9.0-pre.1

Lockstep bump to 0.9.0-pre.1; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.1 for the line's notes.

## 0.9.0-pre.0

Initial release — the six conformance kits consolidated into one package with one subpath per hub port (`@noy-db/ports/to`, `/as`, `/at`, `/on`, `/by`, `/capsule`). Exported function names are unchanged from `@noy-db/test-adapter-conformance`, `test-format-conformance`, `test-sealer-conformance`, `test-ceremony-conformance`, `test-mesh-conformance` and `test-capsule-conformance`, which now re-export from here and are deprecated in favour of it. **Not a break for a consumer of those names:** function names and signatures are unchanged and the peers are the same (`@noy-db/hub`, `vitest`); only the import specifier moved, and the old specifiers keep working through the shims. Six self-contained entries, each resolved and called by `__tests__/subpaths.test.ts` through the package's own `exports` map.
