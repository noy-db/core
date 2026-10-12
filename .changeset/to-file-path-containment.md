---
"@noy-db/to-file": patch
---

**Fixes a live bug: persisted index side-cars could never be written to a to-file mount.** Hub materialises them as records whose *id* is `_idx/<field>/<recordId>`, and `put` created only the collection directory, so the atomic write failed with `ENOENT` on its `.tmp` leaf. It now creates the id's parent (family#133).

to-file also refuses path segments that would leave their namespace, as defence in depth beneath the check hub performs at the kernel boundary. `vault` and `collection` must be single names — not empty, `.`, `..`, or containing a separator; a record `id` may contain `/`, because hub's side-cars do, but no slash-separated component may be empty, `.` or `..`. Refusals are `ValidationError`, including for a NUL byte, which previously surfaced as a bare `ERR_INVALID_ARG_VALUE` from `fs`.

⚠️ Containment against the store directory is the backstop, not the guard: `join(dir, 'v', '..', 'i.json')` resolves to `{dir}/i.json`, which is still *inside* the store and outside the **vault**. On a multi-tenant mount that is the boundary that matters, which is why segment shape is checked per segment rather than only on the resolved path.
