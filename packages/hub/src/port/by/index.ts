/**
 * `@noy-db/hub/by` — the mesh port for `by-*` session-share transports.
 *
 * A `by-*` transport (`by-tabs`, `by-peer`) binds ONLY to this subpath: the
 * drain-barrier contract for the schema-fence cutover — who is live, and what
 * generation are they on. `@klum-db/lobby` drives the same port through the
 * `Noydb` handle (`db.mesh`) without ever naming a `by-*` package.
 *
 * `StoreMesh` — the store-polling default — lives in
 * `with-shape/schema-update`, its only consumer, and is intentionally NOT
 * exported here. It is hub's own implementation of this port and the one most
 * consumers actually run, and `@noy-db/ports/by` cannot import
 * it.
 *
 * ⚠️ That was recorded here as a coverage cost, generalised to *"a port's
 * in-hub default is coverable by its published kit only if it is on the
 * published surface"*. The generalisation is FALSE and the kit now proves it
 * (core#46): `createNoydb()` installs this default and `db.mesh` hands it
 * back, so the kit runs the contract against `StoreMesh` — two clients over
 * one store — while importing nothing from `with-shape/`. **REACHABILITY
 * decides, not exportedness**, and the two come apart wherever a port's
 * default is installed by a constructor. The export decision below is
 * unchanged; only the cost attributed to it was wrong.
 *
 * ## Why this subpath exists again
 *
 * It shipped in 0.3.0 and was pruned in 0.4.0 for "zero importers" — correct at
 * the time, because it was a second place to find types that were already on
 * the root barrel. It returns in the 0.7 line because something now stands
 * behind it: the contract is published as an executable suite, and two
 * transports implement it. Ports first, then seams.
 *
 * ⚠️ That last sentence was FALSE when this seam first shipped (#1171).
 * `by-peer`, `by-tabs` and the conformance kit all imported `NoydbMesh` from
 * `@noy-db/hub/cargo`, so `/by` was republished with **zero binders** — the
 * exact condition it was pruned for — while this comment claimed otherwise. A
 * subpath resolves whether or not anyone imports it, so nothing was red. The
 * three were migrated, and `family-port-has-binder` in check-architecture.mjs
 * now asks the question on every run rather than trusting the sentence.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit
 * and tsup's per-entry bundling keeps class identity stable across subpaths.
 * Everything here also remains on `/cargo`, which is where the 0.4 codemod row
 * sends a consumer — this is additive, and that row stays true.
 */
export { isQuorum, runDrainBarrier } from './types.js'
// #54 — `observeFence` and `observePresence` RETURN `Unsubscribe`, and it was
// not nameable from here: a transport author returned `() => {}` with nothing
// to annotate it against.
export type { Unsubscribe } from '../with/write-hooks.js'

// ⛔⛔ `FenceState` is DELIBERATELY NOT EXPORTED HERE, and the reason is not
// the 0.6 hand-copy — it is the CODEMOD (#54, measured).
//
// `FenceDoc.fenceState` is a `FenceState`, so by the same argument as
// `Unsubscribe` above this port "should" carry it. It must not.
// `codemods/0.7.0-pre.json`'s `FenceState → FenceDoc` row is scoped to
// `./by` + `./cargo` and disambiguates BY IMPORT SOURCE: an import of
// `FenceState` from `@noy-db/hub/by` is the dead two-field interface and gets
// rewritten; one from `@noy-db/hub` is the live string union and is left
// alone. Exporting the union here would make a CORRECT new import
// indistinguishable from the dead one, and the codemod would confidently
// rewrite it into a different type. `codemod-map-0.7.test.ts`'s
// "every hub `from` is genuinely GONE" fails the moment this is attempted —
// that is how this was caught, not by review.
//
// A `by-*` author writes the literal (`'normal'`), which type-checks against
// `FenceDoc`. Reopening this means retiring the codemod row first.
export type {
  NoydbMesh,
  WriterPresence,
  FenceDoc,
  DrainBarrierOptions,
} from './types.js'
