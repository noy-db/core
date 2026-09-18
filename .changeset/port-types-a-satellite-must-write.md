---
'@noy-db/hub': minor
---

**`/to` and `/by` now export the types a satellite has to WRITE, not only the ones it reads** (core#54, ruled on noy-db/family#29's successor thread).

**Added, all additive and all already on the root barrel:**

| subpath | types |
|---|---|
| `@noy-db/hub/to` | `StoreAuth`, `StoreAuthKind` |
| `@noy-db/hub/by` | `Unsubscribe` |

### What was actually broken

Nothing failed to compile, which is why this survived every export check we have. Both ports required a satellite to produce a value whose **type it could not name**:

- `StoreCapabilities.auth` is a **required** field of the store contract. A `to-*` author could write `auth: { kind: 'none', required: false, flow: 'static' }` inline — structural typing accepts it — and could not write a helper returning `StoreAuth`, annotate a field, or re-export the type.
- `NoydbMesh.observeFence` and `observePresence` **return** `Unsubscribe`. A `by-*` author returned `() => {}` with nothing to annotate it against.

⭐ **A type you can satisfy by literal but cannot name is a partial form of "exported but unusable"** — the seam is bindable, and only for authors who never factor their code.

⛔ **`FenceState` was considered for `/by` and deliberately NOT added**, so its absence reads as a decision rather than an oversight. `FenceDoc.fenceState` is a `FenceState`, so the same argument applies — but `codemods/0.7.0-pre.json`'s `FenceState → FenceDoc` row is scoped to `./by` + `./cargo` and disambiguates **by import source**: from `@noy-db/hub/by` the name means the dead two-field interface and is rewritten; from `@noy-db/hub` it means the live string union and is left alone (#1188). Exporting the union on `/by` would make a *correct* import indistinguishable from the dead one and hand the codemod a confident wrong edit. A `by-*` author writes the literal `'normal'`, which type-checks against `FenceDoc`. Reopening it means retiring the codemod row first.

### How it was found, and why that is the durable part

By the `@noy-db/hub/by`-and-friends **bindable-alone fixtures** (core#54): five programs, one per published port, each compiling a satellite's whole import list — one line — plus a real caller. Both gaps surfaced on first contact, and neither is visible to a surface golden, a runtime export enumeration, or a prose gate, because in this failure mode every identifier resolves.

The argument was already written into `src/port/to/index.ts` for `isConflictError` — *"a store binds `/to` and nothing else, so exporting the predicate only from the root told store authors to use something they could not import"* — and had not reached the two types four lines below it. That comment now says it applies to every symbol an implementer must write, not only to predicates.
