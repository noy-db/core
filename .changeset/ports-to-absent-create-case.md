---
'@noy-db/ports': patch
---

`@noy-db/ports/to`: assert what `put` does with an `expectedVersion` against an **absent** id — the create lands, and the next create conflicts (core#134).

The kit's three CAS cases all operated on a record that already existed, so the absent case was unasserted and the one-line contract ("throws if `expectedVersion` doesn't match") reads unconditional — two natural implementations take it opposite ways.

⭐ Censused 2026-09-24, every record store in the family had already converged on "the create lands", `to-aws-s3` deliberately and by name. This case **holds** that agreement rather than introducing a requirement: it passed on every in-tree adapter when added. An out-of-tree adapter whose conditional write rejects a missing item must OR in an existence check, as `to-aws-dynamo` does.

⭐ Consequence: because no hub record starts below `_v: 1`, this makes `expectedVersion: 0` an exact "write only if absent" with **no** sentinel in the signature and **no** seventh method on the six-method contract.
