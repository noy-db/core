---
"@noy-db/hub": patch
---

keyring: rotateKeys CASes each record it rewrites (family#163)

The per-record rekey is a read-modify-write and it had no compare-and-set. A
concurrent writer between the read and the write was **silently lost**, and the
stored version **regressed** with it.

`rekeyEnvelopeToDek` carries `_v` through unchanged — an in-place rekey is "same
`_v`, new bytes" by design (core#100) — so writing the re-keyed copy of version 5
over a concurrently written version 6 put the record back at 5. Measured before
the fix: no throw, `_v` back to 1, the concurrent body gone.

**The regression is the worse half.** Sync orders by `_v`, so a peer that had
already pulled 6 would never re-pull 5: the loss propagates as convergence.

Each write now CASes at the version it read, and on conflict the rotation
**re-reads and re-keys the newer version** rather than failing — failing would
leave the collection half-rotated, which is the state this function is built to
be resumable from. Bounded at three attempts: a writer hot enough to win three
races will win a fourth, and looping inside a rotation that holds the caller's
keyring is worse than a loud failure a resume can finish.
