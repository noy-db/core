---
"@noy-db/hub": patch
---

**`vault.sequence()` can now issue from ONE authority across devices
(family#206).** Counters were per-device: `_sequences` is not replicated and
`next()` CASed against the local store, so two devices on the same series name
produced the same numbers. Measured before the fix — A `next()` → 1, A pushes,
B pulls the whole vault, B `next()` → 1. Two records numbered 1 after a
*complete* sync cycle, because the pull cannot help when there is nothing to
pull. For a fiscal invoice number that is a duplicate in the books.

```ts
// Issues from the attached sync-peer's store, so every device shares one counter.
const n = await vault.sequence('invoice-2026', { authority: 'remote' }).next()
```

`authority` defaults to `'local'`, which is **exactly** today's behaviour —
per-device, unchanged, and still right for anything that does not need to be
unique across a fleet. `resolveSequenceKey` derives the storage key from
`partition` only, so adding the option cannot move an existing counter; the two
authorities do address different stores, though, so their values are
independent (`seedTo` the remote one when migrating a series that has already
issued locally).

**It fails closed, and never falls back to the local counter.** A new
`SequenceAuthorityUnavailableError` (exported from the root barrel, beside
`SequenceOfflineError`) carries a `reason`:

- `'no-target'` — no sync-peer target is attached. A `backup`/`archive` target
  does not qualify: those are push-only, so reading a counter back from one was
  never part of their contract.
- `'not-cas'` — the sync-peer's store does not advertise
  `capabilities.casAtomic`, so it cannot serialize concurrent issuers.
  `@noy-db/to-file` is `casAtomic: false` by construction, so a USB or
  shared-folder target can hold a vault and still not be a numbering authority.
- `'no-key'` — this device has not yet pulled the `_sequences` key. It is
  **not** minted here: minting would seal the shared counter under a key the
  peer cannot unwrap, which surfaces later as an *unreadable* counter rather
  than a wrong number. `_keyring` replicates, so the remedy is a pull.

A silent fallback would reproduce the duplicate numbers this closes while
looking like it worked, and for the series people ask this for a duplicate is
worse than an outage. The refusal is raised when the handle is USED
(`next`/`peek`/`seedTo`), matching `SequenceOfflineError`, so acquiring a handle
stays safe and a handle acquired before `attachSyncTarget()` begins working
after it.

⚠️ **`_sequences` is still not replicated, deliberately.** Replicating the
counter and letting the higher value win cannot be expressed: the reserved
mirror is DEK-free by construction, so no rule there can compare two sealed
counter values, and the only available rule (the envelope's `_v`) is wrong in
both directions for independently-incremented counters — equal versions make
the pull a silent no-op, and unequal ones pick by write count and can move a
counter backwards. The reasoning is recorded beside `RESERVED_REPLICATION`.
Remote authority solves the same problem on the issuing side instead, where
there is one counter and nothing to reconcile.
