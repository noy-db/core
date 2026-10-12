---
"@noy-db/ports": patch
"@noy-db/to-file": patch
"@noy-db/hub": patch
---

to: a record id may contain a NUL, and a filesystem store encodes it (family#174)

Hub emits NUL-bearing record ids. `resolveSequenceKey` and `resolvePeriodKey`
join a partition as `${name}\x00${parts}`, chosen precisely because a NUL cannot
occur in a plain series name — so a partitioned key can never collide with an
unpartitioned one. `to-file` refused the byte, so **a partitioned sequence or
period could not be stored on it at all**, and never could: the OS rejects a NUL
in a path whatever the adapter does. Both suites were green, because nothing in
the conformance kit asked.

`@noy-db/ports/to` now has that case: an id containing `\x00` must round-trip
through `put`, `get` **and `list`**, and must remain a distinct key from the same
string with the byte removed. `list` is part of the assertion rather than
thoroughness — an encoding with no matching decode produces a store that reports
an id no `get` resolves, so `loadAll`, sync enumeration and export all see a
phantom key, and a put/get pair cannot see it.

`to-file` encodes id components reversibly and decodes on `list`. `%` is escaped
first because otherwise the encoding is not a bijection: the literal id `a%00b`
and the id `a\x00b` would both land in `a%00b.json` — two records, one file.

**Scope is `%` and NUL, not every character some platform refuses.** Each extra
character widens the set of existing on-disk names that move: an id containing
`:` is storable on POSIX today, so encoding it would relocate live records for a
portability benefit nobody asked for. NUL cannot be stored today, so encoding it
breaks nothing. Widening to the win32 reserved set is a separate decision.

`get` falls back to the pre-encoding path, so a live record whose id contains a
`%` stays readable. `list` reports such a legacy id under its decoded name,
which still resolves but is reported wrongly — a narrow, read-only residual
corner, declared rather than discovered.

`NoydbStore`'s contract docstring now states all of this, since it is the
authority an adapter author reads.
