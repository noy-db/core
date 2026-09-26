# @noy-db/exclave-plain

## 0.9.0-pre.2

Lockstep bump to 0.9.0-pre.2; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.2 for the line's notes.

## 0.9.0-pre.1

Lockstep bump to 0.9.0-pre.1; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.1 for the line's notes.

## 0.9.0-pre.0

Lockstep bump to 0.9.0-pre.0; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.0 for the line's notes.

## 0.8.0

Initial release. The **plaintext capsule** for noy-db — typed collections, schema and `via` fields, the query DSL and most services, with **no encryption at all**. Rows are stored as readable data with MAC-bound integrity, for the one shape of application whose table is read *and written* by other tools and whose access control already lives outside the database (IAM, a VPC, a database grant).

Installing this capsule moves the security boundary out of noy-db and into your store, and noy-db stops being zero-knowledge. That is the trade it exists to make; callers who are not deliberately making it should stay on the default `enclave-aes`, which ships inside `@noy-db/hub` and needs no configuration.

Bound at build time through hub's `imports` map, and verified against the capsule contract by `@noy-db/test-capsule-conformance`.

Apache-2.0 from this, its first published version.
