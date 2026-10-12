---
"@noy-db/hub": patch
"@noy-db/to-file": patch
---

hub: one central segment check around the mounted store (family#133)

`createNoydb()` wraps the mounted store in `guardStoreSegments()`, so a vault or
collection that is not a single segment, and a record id with an empty, `.` or
`..` component, are refused before any store sees them.

The segment rule was already part of the store contract, but every store
enforced it alone — so a malformed id reached whichever store the caller mounted
and nothing above it refused first. `to-file` paid for that: `join` *collapses*
`..` rather than refusing it, so `join(dir, vault, '..', id)` escapes the
**vault** while staying inside the store directory, and on a multi-tenant mount
the vault boundary is the one that matters. A key-value store has no such
failure and therefore no reason to have written the check, which is exactly why
it belongs in hub.

**It enforces the stated contract, not a superset**, and the difference is not
academic — a first version that refused more broke 60 of hub's own tests. Two
characters hub uses deliberately in an id: `/`, because persisted index
side-cars are `_idx/<field>/<recordId>`; and `\x00`, because
`resolveSequenceKey` and `resolvePeriodKey` join a partition as
`${name}\x00${parts}` *precisely* because a NUL cannot occur in a plain series
name, so a partitioned key can never collide with an unpartitioned one. What is
refused for an id is exactly what the contract states: an empty, `.` or `..`
component. `vault` and `collection` are stricter because the contract says they
are single names.

`Noydb.store` still returns the **raw** store the caller mounted, not the guard
proxy — `===` against their own argument is what that accessor is for.

Implemented as a **Proxy**, not `{ ...store, get() {…} }`. A spread copies own
enumerable properties only, so a store implemented as a class loses every
prototype method the wrapper does not redeclare — `listPage`, `tx`,
`getStoreTime`, `listSince`, `ping` vanish silently and hub takes its fallback
paths as though the store never offered them. `this` is bound to the target, so
a class store's `#private` fields keep working. (`with-store`'s `wrapStore`
middleware still has the spread shape; that is family#173.)

A refusal **rejects** rather than throwing synchronously: every guarded method
is declared `Promise<…>`, and a synchronous throw from one cannot be caught the
documented way — `store.get(…).catch(…)` never sees it.

`to-file`'s own guard stays, and is now a backstop rather than the only check:
an out-of-tree caller can hold a `NoydbStore` reference and never pass through
hub.
