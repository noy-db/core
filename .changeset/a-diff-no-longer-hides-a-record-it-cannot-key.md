---
"@noy-db/hub": patch
---

cargo: a diff no longer hides a record it cannot key (family#151)

`diffVault` keyed **both** sides on a record field (`options.idKey`, default
`'id'`) and skipped any record that had none. Hub's id is the **store key**, not
a property of the plaintext, so a record genuinely need not carry one — and such
a record landed in no bucket. `@noy-db/hub/as`'s `plan().apply()` walks only
`added`/`modified`/`deleted`, so **an import silently did not write it**: no
error, no count, nothing.

Two fixes, because the two candidate kinds differ in what they *can* be keyed
by:

- **Vault candidate** — both sides are keyed by the hub id, which every record
  has. `ExportChunk` now carries `ids`, positionally aligned with `records` and
  always populated (unlike `envelopeMeta` it costs nothing: both yield paths
  already iterate the id list, and a flag is a way to forget it). Optional in the
  type so a consumer constructing a chunk stays valid.
- **Object or `dump()`-string candidate** — carries no hub ids at all, so keying
  the live side by hub id against a field-keyed candidate would mismatch every
  record and report the whole vault added-and-deleted. That path still keys by
  field and now **reports** the skip: `VaultDiff.skipped`, a count on
  `summary.skipped`, and a `· N SKIPPED (unkeyable)` note in `format()` at every
  detail level including `'count'` — `format()` is what a human reads before
  approving an import.

⚠️ `summary` gained a field, so an exact `toEqual` on it needs `skipped: 0`.

**Round-tripping an id-less record through `/as` is still blocked, and not by
this code.** `exportVaultJSON` emits `records: [...]`, dropping the hub id, so
no object or string candidate can be keyed by it. Carrying ids in the export
format is a `/as` decision — the same positional-array question family#166
answered for envelope metadata — and is reported rather than taken here.
