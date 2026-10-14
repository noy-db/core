---
"@noy-db/hub": patch
---

**Fixed: a never-pushed record written more than once always conflicted on its
first push (family#224).** Each such record cost **two remote puts and a CAS
refusal** instead of one put — on DynamoDB, a `ConditionalCheckFailedException`
(a 400 in the console) per record: one reported window had 107 refusals for 106
successful `PutItem`.

The dirty log deduplicates by `(collection, id)` and replaces the entry, so the
third local write of a never-pushed record carried `version: 3` and push derived
its CAS expectation as `version - 1` = 2 — while the remote held nothing. The
conflict path then recovered by retrying at `expectedVersion: 0`, so the write
succeeded but paid for a round trip and logged an error.

`DirtyEntry` now carries `base`: the version the remote is believed to hold,
captured when the record first becomes dirty and preserved across later local
writes. The remote has not advanced just because this device wrote again.
Genuine divergence still conflicts.

⚠️ Also fixes an inconsistency between the two push paths: `pushFiltered`
expected `version - 1` for a `rekey` where `push` expects `version`, so a
*filtered* push of a re-encrypted record conflicted where a full push
succeeded. Both now use one expression.
