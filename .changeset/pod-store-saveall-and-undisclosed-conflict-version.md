---
"@noy-db/hub": patch
"@noy-db/ports": patch
---

Two follow-ups to the family#147 store-contract change, both found by applying it beyond core.

**`wrapPodStore.saveAll` destroyed the keyring on a restore.** It replaced the whole snapshot map, so a snapshot that did not carry `_keyring` dropped the live one. On this wrapper that was a guaranteed loss rather than a hazard: its `loadAll` deliberately strips `_`-prefixed collections (#908), so `saveAll(await loadAll(vault))` — a backup followed by a restore, the exact pair the two methods exist for — left the pod with no keyring and therefore unopenable. It now follows the same rules as every other store: non-underscore collections are replaced, reserved ones are never pruned but are overwritten when the snapshot carries them. Every pod-shaped backend (`to-drive`, `to-icloud`) enters the store contract through this wrapper.

**The conformance kit no longer requires a remote to disclose a conflict version.** The absent-id case asserted `ConflictError.version === 0`; it now accepts `0` or a non-finite version. A store whose backend does not return the current version in its 409 body has nothing to parse and must not be forced to invent a number. The `ConflictError` itself is still required — a generic failure would make "your premise is stale" indistinguishable from "the store is broken" — and a *wrong* finite version is still a failure.
