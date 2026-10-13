---
"@noy-db/to-file": patch
---

**`to-file`: a case-folding filesystem could eat both records (family#217).** On a
case-insensitive volume — APFS and NTFS by default, and any SMB/exFAT mount or
Docker bind mount from a macOS host — `put('Abc')` followed by
`saveAll({ c: { abc } })` left the collection EMPTY: `list()` returned `[]` and
`get('abc')` returned `null`. Neither record survived and nothing threw.

`saveAll` never ran the case-collision guard that `put` has had since
family#177, so the snapshot's `abc` body was written into the folded
`Abc.json`; the prune pass then asked whether `Abc` was in the snapshot, found
it was not (the snapshot says `abc`), and unlinked the file it had just
written. The guard now runs over the whole snapshot **before** any of it is
written, so a snapshot the store cannot represent is refused in full rather
than applied halfway.

Two further defects in the same guard, both of which could switch it off:

- **The check covered the filename only.** Ids may nest — `encodeId` maps `/`
  to `/`, which is how a side-car id like `_idx/<field>/<record>` is stored —
  and a folded *directory* component collapses two distinct ids one level
  above where the check was looking. With `A/x` on disk, writing `a/x` found
  the parent (resolved by the filesystem to `A`), compared leaf `x.json`
  against `x.json`, found them equal and returned clean. Every path component
  is now checked, and a directory-level collision says so in the error.

- **The case probe used a fixed sentinel name.** Two stores opened on one
  directory both probed `.noydb-case-probe-Aa`, and `mkdir` with
  `recursive: true` succeeds on a directory that already exists — so the
  second store adopted the first's sentinel and its cleanup deleted it. If
  that landed between the first store's `mkdir` and its `stat`, that store
  concluded the filesystem was case-SENSITIVE and cached it for its whole
  lifetime, disabling the collision guard entirely. The sentinel now carries a
  per-instance tag.

Refusing remains the conformant response (`@noy-db/ports`' `/to` suite allows
either refusing or representing both ids; what it forbids is accepting the
write and keeping neither), and the new tests assert record SURVIVAL before
they assert the refusal, so they hold for either resolution.
