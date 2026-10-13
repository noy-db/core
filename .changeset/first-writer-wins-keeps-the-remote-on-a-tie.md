---
"@noy-db/hub": patch
---

sync: `conflictPolicy: 'first-writer-wins'` keeps the copy already on the remote on a version tie (family#209)

Two devices editing the same record from the same version each hold the same
next `_v`. The resolver compared `local._v <= remote._v`, so on that tie the
local copy won — and the local copy is the SECOND writer, the one whose push
conflicted because the first writer had already reached the remote. Its push
then overwrote the first writer's change, the opposite of the documented
"earlier version is preserved". A tie now goes to the remote copy (strict
`local._v < remote._v`), so the first writer to push survives and both devices
converge on it; a strictly lower local `_v` still wins as before.
