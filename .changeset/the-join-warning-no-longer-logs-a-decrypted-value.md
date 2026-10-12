---
"@noy-db/hub": patch
---

query: the dangling-ref warning no longer logs a decrypted value (family#167)

`.join()` in `mode: 'warn'` logged `"<target>:<refId>"`, and `refId` is read out
of a **decrypted record body**. `console.warn` goes wherever the host collects
logs — a file, a shipper, a cloud sink — which is outside the zero-knowledge
boundary this library exists to hold. It leaked on an ordinary read path, in the
mode a caller picks in order to be lenient. Both sites are fixed: `Query.join()`
and `ScanBuilder.join()`.

**It is a leak even when the value is an ordinary id.** Two things escaped: the
value, which need not be opaque — a ref resolved by natural key is routinely an
email or an account number — and the **association**, which leaks even for a
store key the backend already sees. The store knows `users/u-1` exists; it does
not know which post references it, because that field sits inside the encrypted
body. The log published the edge.

⭐ The dedup `Set` was the second half, and the bigger one: keyed by
`field → target:refId` it **retained every dangling value in memory for the
process lifetime**, where a heap dump or a memory inspector would find them.
Keyed by `field → target` it holds schema only and stops growing with the data —
and the warning is now one line per leg rather than one per dangling value.

The message still names the field and the target (both schema, not data) and
points at `mode: 'strict'`, which hands the id to the **caller** as
`DanglingReferenceError.refId`. That is a different channel: a caller that
decrypted the record already holds the value; a log leaves the process.

⚠️ A record **id** in a log is a different question and is deliberately not
touched here — the store already sees every key it is asked for, so `id="x"` in
a derivation-failure warning discloses nothing new. The distinction is
decrypted-body content versus a store key, not "anything that looks like an
identifier". A sweep of hub's other 63 `console.*` calls found no further
field-value egress.
