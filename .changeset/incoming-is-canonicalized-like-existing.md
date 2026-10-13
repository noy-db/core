---
"@noy-db/hub": patch
---

sync: a guard saw a change on every pulled record with a money field (family#187)

`_admitRemote` decrypted the incoming record with `skipValidation: true` — which
returns **storage** form — and handed it to guards while `existing` went through
`via.canonicalizeStored`. A guard comparing the two on a `money()` field was
therefore comparing minor units against the canonical decimal: `"100000"` versus
`"1000.00"` for the *same* value.

So every remote compare reported a difference even when nothing had changed. For
an issued (WORM) record, whose guard refuses any change, that means **the record
never syncs** — on either remote origin, `'sync-apply'` and `'push-recheck'`.

The incoming record is now canonicalized exactly as `existing` is.

⚠️ Invisible to any single-shape test, which is why it shipped: a collection with
no via fields canonicalizes to itself, so `incoming` and `existing` have the same
shape and every existing guard test passes either way. Catching it needs a field
whose stored and canonical forms differ.

⚠️ Reported, not fixed here: `#priorForHook` returns a **cached** record on the
hydrated path and a freshly decrypted `skipValidation` record on the lazy path,
so a write hook's `before` is canonical or storage form depending on cache state.
Same asymmetry, a different call path, and outside this issue's scope.
