---
"@noy-db/to-browser-idb": patch
---

to-browser-idb: no unhandled rejection, and no stale cached connection (family#165)

**The unhandled rejection.** `tx()` hands back a `complete` promise that rejects
on `transaction.onerror`, and every read path destructured only `{ store }`. A
transaction that failed therefore rejected a promise nobody was listening to —
an `unhandledrejection` event in a browser, a process-level warning in Node, or
a process **exit** under `--unhandled-rejections=strict`. A store-level read
error could take down the host application, from a path the caller was already
awaiting an error from.

`complete` is now marked handled inside `tx()` with `p.catch(() => {})`, which
returns a *new* promise and leaves the original rejecting for anyone who awaits
it — so the error still reaches the caller. And every read path awaits it, so a
transaction error surfaces instead of being discarded. Swallowing it would have
given a read that silently returned a partial result on a failed transaction,
which is worse than the crash.

**The stale connection.** `dbPromise` held one connection for the adapter's
lifetime, so once it went away every later transaction failed against a dead
handle — permanently, because nothing cleared the cache. Connections go away for
ordinary reasons: another tab runs a `versionchange`, the browser evicts the
origin under storage pressure, the user clears site data. The adapter needed a
page reload. It now invalidates on `onclose` and closes on `onversionchange` —
holding the connection open would block the other tab's upgrade rather than
protect this one.

A **rejected** open was cached too, which is the worse half: one transient
failure at startup — storage not yet granted, a private-mode quirk — was
replayed for every call for the rest of the session. The cache is cleared on
rejection so the next call retries.

⚠️ Two of the five cases are deliberately **structural** — asserting the `tx()`
convention and the invalidation wiring from source. `fake-indexeddb` cannot fire
`transaction.onerror`, and the connection handle is private to the closure, so a
behavioural case for either passes with the fix stashed. One did, and it was
rewritten rather than kept: green cases that measure nothing read as coverage.
Mutation-checked — three of five fail without the fix.
