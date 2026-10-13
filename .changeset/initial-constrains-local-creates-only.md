---
"@noy-db/hub": patch
---

guards: `transitionGuard`'s `initial` rejected every pulled record past its initial state (family#188)

The insert branch fired on `ctx.existing === null` with no reference to
`ctx.origin`. A record arriving on a device that has never seen it has no local
prior — so `initial: ['draft']` refused it with
`IllegalTransitionError('(none)' → 'issued')`. A fresh device could therefore
never receive an already-issued invoice, and for an issued (WORM) record that is
permanent: nothing will re-send it in a state the device would accept.

⭐ `initial` is about **authorship**, not about absence. It says "this
application may only CREATE a record in these states"; a pulled record was
authored elsewhere and already passed that gate on the device that wrote it. So
`initial` now constrains local creates only — `origin` `'local-write'` or absent
— on both remote origins, `'sync-apply'` and `'push-recheck'`.

⚠️ The **arc** check on updates still runs on every origin. A remote update from
a state this device holds is exactly what the transitions map is for, and
exempting remotes there would let a peer drive a record along a forbidden edge.
Both halves are held by controls: a local create in a forbidden state is still
refused, and an unguarded peer still cannot push `paid → draft`.

⚠️ Absent origin counts as local. The non-remote write paths do not set it, and
treating `undefined` as remote would disable the gate for every ordinary `put`.
