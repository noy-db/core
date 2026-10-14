---
"@noy-db/hub": patch
---

**`disconnect()` now writes a removal marker instead of deleting the link row
(family#210, PR 1 of 2).** Prerequisite for replicating link sets; the
stored-shape change is ruled and accepted.

A physical delete cannot replicate. The reserved mirror infers removal from
**absence**, and absence is ambiguous for a set both devices can add to — one
device disconnecting `x–y` while another connects it is indistinguishable from
the second simply not having seen it yet. A marker says *removed here, at this
version*, which the version comparison resolves like any other row.

`_del` goes on the **envelope**, hub's existing delete-marker convention
(#589) that `@noy-db/ports`' `/to` suite already requires every store to
round-trip byte-identically. A body field would be invisible to anything that
cannot decrypt, including the sync mover — which is the point.

`has()`, `list()`, `of()` and the vault-internal endpoint scan all exclude
markers, so nothing observable changes for a caller. Reconnecting a removed
link works and clears the marker. Disconnecting twice is idempotent and does
**not** bump the version — churn there would let a no-op win a comparison
against a peer's real reconnect.

⚠️ **A hub build from before this change fails OPEN on a marker**: its `has()`
was `get(...) !== null`, and a marker is a row that exists, so a removed link
reads as present. This cannot be fixed from hub: `'generation-mismatch'` is
declared for exactly this case and is **not emitted by this build**, because
hub reads no generation stamp off any envelope — so an old build has nothing
to branch on. Making the row undecryptable instead would surface as
`TamperedError`, which is reserved for genuine corruption and would misreport
a format difference as an attack. The behaviour is asserted in a test rather
than described, so it is recorded by something that runs.
