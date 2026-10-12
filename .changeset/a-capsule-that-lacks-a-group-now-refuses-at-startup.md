---
"@noy-db/hub": patch
---

capsule: a capsule that lacks a group now refuses at startup, at two points (family#156)

`createNoydb()` refuses an enabled service whose group the bound capsule does
not declare — `blobsStrategy`, `cargoStrategy` and `tiersStrategy` need
`per-record-keys`, `classifiedStrategy` needs `classify` — before any default is
resolved, so a refused vault is never half-built.

`vault.collection()` refuses a declared field form the capsule cannot honour:
`sensitive` needs `sealing`, `deterministicFields` needs `deterministic`,
`perRecordKeys` needs `per-record-keys`, and a `classifiedFields` member needs
`sealing` for `storage:'recoverable'` or `classify` for `storage:'digest-only'`
and for `equatable`. `storage:'never'` needs nothing — it is the one form a
plaintext capsule can honour, and refusing it would invert the point.

**Two points, not one.** A `classifiedFields` declaration writes `_vdig` with no
`classifiedStrategy` at all: the strategy is the read side, while the codec's
`vdigFields` map comes straight from the declaration at construction. A single
check at `createNoydb()` would have left every write-side requirement
unenforced while looking complete.

`perRecordKeys` is a **collection** option, so it is reachable with
`blobsStrategy`, `cargoStrategy` and `tiersStrategy` all absent — a requirement
a service-only check misses.

`authenticate` and `seal` are in neither table, by measurement rather than
omission: `deriveKey` (secret → KEK) and `wrapKey`/`unwrapKey` (KEK wraps DEK)
are called only from the keyring unlock chain, never from a field form. They are
the posture groups, and what implies them is opening a vault with a secret — a
third refusal point, reported rather than added.

`CapsuleNotSupportedError`'s message now names the posture rule and all six
groups the shipped exclave refuses. It had said an exclave "refuses
`authenticate` and `seal` by design", which reads as the whole story and is how
a consumer concludes a plaintext capsule can still seal a field.
