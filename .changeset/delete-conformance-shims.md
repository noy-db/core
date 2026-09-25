---
'@noy-db/hub': patch
---

**The six `@noy-db/test-*-conformance` re-export shims are removed (family#39 step 5).** They were 8-line `export * from '@noy-db/ports/<port>'` packages kept published while the family's satellites moved off them. Every consumer has now moved — `to`, `as`, `on`, `at` and `daemon` all bind `@noy-db/ports/<port>` directly as of 2026-09-25.

⚠️ **Already-published versions are unaffected.** `@noy-db/test-adapter-conformance@0.9.0-pre.1` and every earlier version stay installable; what stops is the publication of *new* ones. A consumer still pinning a shim keeps resolving it and should migrate to the matching `@noy-db/ports` subpath: `/to`, `/as`, `/at`, `/on`, `/by`, `/capsule`.
