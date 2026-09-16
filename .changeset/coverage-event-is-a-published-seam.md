---
'@noy-db/hub': patch
---

**`CoverageEvent` is a published seam — the `@internal` tag that said otherwise is gone.**

`CoverageEvent`, `CoverageObserver`, `CoverageEmitter`, `CoverageFieldMeta` and `CoverageStrategy` are re-exported from `@noy-db/hub/coverage` and shipped in `0.8.0`'s `.d.ts`. The module declaring them ended its docstring with `@internal`, and **`stripInternal` is set in no tsconfig in this repo** — so the tag stripped nothing and described the opposite of what shipped. A consumer reading the `.d.ts` saw a public type; a contributor reading the source saw an internal one and could reasonably have changed it without treating that as breaking.

Ruled a published seam (core#38, recorded in the family seam registry). The tag is **removed** rather than made true: adding `stripInternal` now would break every consumer already importing the type at `0.8.0`, so the honest edit is the one matching what shipped.

The module now states the two consequences, so an extension cannot lose them:

- **Additive only.** A new sensor **adds** fields and never redefines `served` / `novel` / `coverage` / `window`. Their horizons are mixed by design — `novel` is per-window and under-reports by construction, `served` is all-time, `coverage` is an HLL fraction, `window` is a start — and redefining one per `source` is exactly what makes a controller subscribe once and compute nonsense.
- **`source` stays `string`**, because an enum would make every new sensor a breaking change to hub. Its *values* are allocated in the family registry as `<repo>/<sensor>`; a new sensor claims its value there before it ships.

No runtime change, and no change to any emitted value.
