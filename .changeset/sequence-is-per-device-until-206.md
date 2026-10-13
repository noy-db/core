---
"@noy-db/hub": patch
---

docs: `vault.sequence()` is unique per DEVICE, not across devices (family#206)

A **known limitation**, documented rather than fixed in this release.

`vault.sequence('invoice-2026').next()` promises "no gaps or duplicates under
concurrency", and that holds **within one device only**. The counter record is
CASed against the *local* store, and `_sequences` is absent from
`RESERVED_REPLICATION` (`with-sync/reserved-mirror.ts:108`, whose replicated set
is `_keyring`, `_broker_member`, `_broker`, `_meta`, `_users`, `_delegations`,
`_rejections`), so it never syncs.

⛔ **Two devices issuing from the same sequence name produce the same numbers.**
Measured here, not relayed: with `withSync()` and `withSequence()` on both
devices, device A calls `next()` → **1**, pushes; device B pulls the whole
vault and calls `next()` → **1**. Two invoices numbered 1, after a complete
sync cycle.
Do not use `vault.sequence()` for an invoice number that must be unique across a
fleet until family#206 lands — it is the first item of the next cycle.

`sequence()`'s docstring now says so at the call site.
