---
"@noy-db/hub": patch
---

**`@noy-db/shamir` is no longer published — one fewer package in this cut
(family#73).** The Shamir math stays in the repo and hub keeps using it for the
six managed-mode/recovery test files that exercise real k-of-n behaviour; the
package is simply marked `private`, so it is absent from the publish set.

Nothing imports it outside this repo any more: `@noy-db/on-shamir` dropped its
dependency on it (it carries no `@noy-db/shamir` dep as of `0.10.0-pre.2`), and
it implements no hub contract, so no satellite peer range changes.

⚠️ **Already-published versions stay installable.** `@noy-db/on-shamir@0.9.0`
and every earlier stable still declare `@noy-db/shamir: ^0.8.0-pre.0`, so the
package is **deprecated, never unpublished** — removing the tarballs would
break those installs.
