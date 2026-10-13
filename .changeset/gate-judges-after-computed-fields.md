---
"@noy-db/hub": patch
---

periods: a computed `dateField` dodged the closed-period seal (family#202)

**An integrity bypass.** The `beforePut` gate bus ran *before* computed scalar
fields were evaluated, so a computed `dateField` was still `undefined` when the
closed-period guard judged the record. `couldGovern` reads an absent date as
**outside every period** (`with-audit/periods/vault-facade.ts:660` — #1455's
deliberate rule, since a record with no date belongs to no period), so the guard
never fired and the write landed inside a sealed period.

The gate now dispatches *after* the computed block, still before any
schema/i18n/history work.

⭐ Two bypasses, and only one was reported:
- **create** — a new record whose computed date falls inside a closed period.
- **back-dating an update** — the existing record sits *outside* the period, so
  the prior-side check stays quiet, and the re-put's computed date lands
  *inside* it. Neither side fired, and the record was moved into sealed history.

⚠️ Narrower than the issue stated in one respect: an update to a record
**already** sealed was never vulnerable, because the guard also checks the
existing prior (`periods.ts:770`), which carries its persisted computed field.
Kept as a control.

⛔ Fixed by moving the gate down, not by moving computed up (that would put
computed ahead of `via.enforceWrite`, whose contract says it runs before
anything derives, and would make `ComputedFieldError` outrank a gate refusal),
and **not** by dispatching twice — the gate's amendment branch collects without
throwing, so a second dispatch double-collects.

⚠️ Remote admission was never affected: `_admitRemote` builds its event from a
decrypted **stored** record, which already carries its persisted computed
fields.
