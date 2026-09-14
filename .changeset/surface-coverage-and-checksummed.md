---
'@noy-db/hub': minor
---

**`classified.checksummed({ validate })`** (#26) — a preset for a checksummed government or institutional identifier: a national ID, a tax number, an employer registration.

The value is the four security-relevant defaults, not the typing saved. Hand-rolling a `ClassifiedFieldSpec` means choosing `storage`, `list`, `sensitivity` and `verifyNormalize` per consumer, and getting `sensitivity` or `list` wrong on a national identifier is not cosmetic. Supply the checksum — `luhnCheck` is exported for Luhn, bring your own for mod-11 — and the posture is decided for you: `recoverable` storage with an omitted list, overridable deliberately.

⛔ Its doc states plainly that such a field **cannot be uniquely indexed**, and why: a recoverable classified field is sealed, sealed fields are excluded from the deterministic index, and unique constraints read the *decrypted* record where the value is a `Sealed` handle. Exact-equality dedup and non-residency are mutually exclusive today, so a field needing `unique: true` must stay plain.

**`Envelope` now documents that there are two kinds of body**, because conflating them is a real bug that cost a downstream package time in 0.8.0. A record can *have* a body while having no *sealed* body: reserved collections (`_keyring`, `_meta`) and any `encrypt: false` collection store readable JSON in `_data` with `_iv: ''`. `hasSealedBody` tests `_iv`, so guarding a `_data` read with it rejects every valid record on those collections. To ask "is there a body to read as text", test `_data` itself.

**Internal, no API change:** every one of hub's 55 published subpaths now has a frozen value surface, and a test fails if a subpath gains or loses one. Previously 11 of 55 were frozen — and a *missing* golden read identically to a clean one, which is how three separate sessions independently concluded an export did not exist when it did. An instrument that can only say "absent" is indistinguishable from one saying "verified absent".
