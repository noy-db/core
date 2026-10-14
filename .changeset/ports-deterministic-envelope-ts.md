---
"@noy-db/ports": patch
---

**`/to` conformance: `makeEnvelope`'s `_ts` is derived from its arguments, not
the clock (family#217 follow-up).** It was `new Date().toISOString()`, so two
calls with the same arguments produced envelopes differing by a millisecond
whenever the clock ticked between them — making any case that rebuilt an
envelope to compare against flaky at roughly 1 run in 5:

```
- "_ts": "2026-10-13T18:21:11.847Z"
+ "_ts": "2026-10-13T18:21:11.846Z"
```

⚠️ **For store authors: this removes a source of intermittent failures you had
no way to attribute.** Because the kit is published, a flake here reads as a
flake in *your* store. Nothing in the suite asserts on a `_ts` value, so the
timestamps being synthetic costs no coverage; they are derived from `version`
rather than frozen outright, so identical arguments still mean an identical
envelope and different versions still mean different envelopes.

No case changed behaviour, and no new case was added.
