---
"@noy-db/ports": minor
"@noy-db/hub": patch
---

`@noy-db/ports/to` now covers record-id shape (family#133). Three cases: a slash-bearing id round-trips, a slash-bearing id stays distinct from a flattened one, and a `..` component never becomes readable under a different `(vault, collection)` pair.

⭐ The asymmetry is deliberate and the obvious "reject suspicious ids" implementation fails it. A store **must accept** `/` in an id, because hub materialises persisted index side-cars as `_idx/<field>/<recordId>` — `to-file` refusing to create the nested directory meant that feature never worked there at all. What a store must guarantee is **containment**, not rejection; refusing outright also passes, since that is what hub does for every store.

The `NoydbStore` docstring now states the rule as contract: `vault` and `collection` are single names, never empty, `.`, `..` or separator-bearing; an id may carry `/` but no component of it may be empty, `.` or `..`. It also names where the rule is enforced, so a store author knows they are implementing containment rather than validation.

The kit's own false-control set gains `broken-escapes-namespace` — a store that collapses `..` and lets an id climb out of its vault, failing in exactly one case.
