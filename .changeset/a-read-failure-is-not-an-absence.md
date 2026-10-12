---
"@noy-db/to-file": patch
"@noy-db/hub": patch
---

to-file: a read failure is no longer reported as an absence (family#162)

`get` returned `null`, `list` returned `[]` and `loadAll` returned `{}` for
**every** read error — a permission error, an I/O error, a corrupt body — which
are the same values those methods use for "not there".

Hub acts on those answers, and one of them is a fail-closed gate:
`assertKeyringOpenAllowed` refuses to self-provision into a vault held by other
principals by checking `list(vault, '_keyring')` for emptiness. An EACCES on the
vault directory made that gate read a populated vault as a genuinely-new one, so
hub provisioned a second owner into it. A corrupt record body failed more
quietly: `get` returned `null`, the record read as absent, and the next write
replaced it.

Only `ENOENT` and `ENOTDIR` now mean absence. Everything else — including a
`JSON.parse` failure on a torn write — reaches the caller. The write-side twin is
fixed too: `delete` treats a missing file as success, as it should, but no longer
reports an EACCES as a completed delete that sync and forget will act on.

`NoydbStore`'s contract docstring now states the rule, since a conformance suite
cannot inject a read failure into an arbitrary store — this is a contract a store
author honours, not one the kit can check — and
`assertKeyringOpenAllowed` records that its fail-closed property rests on it.

⚠️ Hub needed no code change: it already propagates a store that throws. Its new
cases are regression guards for the only part of the duty hub can hold — not
swallowing a store that reports a failure honestly.
