---
'@noy-db/hub': patch
---

**A keyring CREATE is now race-safe: `writeKeyringFile` writes with `expectedVersion: 0`** (core#134, completing core#132).

core#132 made keyring writes CAS against the version they were computed from, which caught concurrent **updates** to one member. It left the **create** race open: two concurrent grants of the same new `userId` both succeeded and the second silently replaced the first — a member who appeared to have been granted access, holding a keyring nobody else's view agreed with.

That limit was attributed to the store contract being unable to express "write only if absent". core#134 measured the claim and it was **wrong**. hub never stores a version below 1, so on a store that compares only when the record is present, `expectedVersion: 0` lets the first create through and conflicts every later one — an exact "must not exist", with **no sentinel added to `put`'s signature and no seventh method on the six-method store contract**. Both were costed; neither was needed.

⭐ What was actually missing was an **assertion**, not a mechanism. `@noy-db/ports/to`'s three CAS cases all operated on a record that already existed, so the family's convergence on this behaviour was held by nothing and a third-party adapter owed it nothing. The kit's absent case (core#138) now holds it, and `noy-db/to` ran it green across **19 adapters** before this line changed. hub's history ledger had already been relying on the behaviour unasserted (`adapter.put(..., expectedVersion: 0)` claims a chain slot), so the assertion retro-covers a dependency that was live.

⛔ **Still not protected, and not closable here: a mixed fleet.** An older hub writes keyrings at `_v: 1` with no `expectedVersion` at all, so it clobbers a new hub's CAS — create or update alike. The guarantee is real only once every writer is a new hub.

⚠️ **Adapter authors:** the contracted answer is that the FIRST create SUCCEEDS. Do not implement absence by throwing. If your backend's conditional write rejects a missing item, OR in an existence check the way `to-aws-dynamo` does; the kit case asserts both halves, so this failure mode reddens rather than passing as "safe".
