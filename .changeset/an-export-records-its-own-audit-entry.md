---
"@noy-db/hub": patch
---

as: an export records its own audit entry (family#151)

`vault.export()` now appends a tamper-evident ledger entry —
`reason: '<tier>-export:<formatId>'`, e.g. `plaintext-export:csv` — from
`exportWith` rather than leaving it to each `as-*` package.

Every format reaches the vault through that one method, so a per-package write
is a duty each author can forget silently, and a ledger that records *some*
plaintext exports and not others is worse than one that records none: the gap is
invisible to whoever reads it.

**Appended after the decrypt and before `encode`.** The chunks are plaintext by
then — that is the disclosure the entry exists to record, and a format whose
`encode` throws has not un-disclosed it. One case asserts exactly that, since it
is the property a later tidy-up would move.

The reason carries the **tier** as well as the format id, because
`assertCanExport` already treats plaintext and bundle as different grants, and an
audit trail that collapsed them would say less than the gate.

It is a **no-op without a history strategy** (`_getLedgerOrNull()`, never a
mint): creating the audit trail as a side effect of a caller's first export would
opt them into a subsystem they never asked for, and the `_ledger` DEK would
outlive the export.

Nothing is recorded when the capability gate refuses, which runs before a single
record is read — there is no disclosure to record, and an entry would report an
export that never happened.

⚠️ Reported, not changed: `exportAccessibleData` appends after its bytes are
built and would under-record the same way if its builder threw.
