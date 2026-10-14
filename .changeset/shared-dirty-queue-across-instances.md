---
"@noy-db/hub": patch
---

**Fixed: two hub instances on one local store (two browser tabs) did not see
each other's pending sync writes (family#225).** Each instance loaded the dirty
queue once at open and then drove `push()` and `pull()` off that snapshot, so a
write tracked by one tab was invisible to the other. Two consequences, measured:

- a record written in a second tab went out only when **that** tab pushed, or
  when something reopened the store. A tab that pushed all session long never
  sent it;
- worse, `pull()` decides whether an incoming record collides with a local
  edit by consulting the same snapshot. Blind to the other tab's mark it
  treated a dirty record as clean, applied the remote copy over it, consulted
  **no resolver** and emitted **no conflict**. Under `conflict: 'local-wins'`
  the local edit was silently discarded — on the identical sequence, a single
  instance reported the conflict and kept the edit.

The per-entry queue introduced in family#223 is already shared and durable, so
the fix is to treat **the rows as the queue** and the in-memory list as a cache
of them: `push()`, a filtered push and `pull()` reconcile from the rows first.
⛔ Never on the write path — a per-write enumeration is the O(N) shape
family#223 removed; a tracked write still costs one constant-size put, and a
push reconciles once regardless of how many entries are queued.

A write tracked by a second instance also carries the **base version** the
first one captured, so the compare-and-set on push still expects what the
remote actually holds rather than a value recomputed from a partial view.

Two instances pushing the same entry is safe and silent: the loser's CAS is
refused, it re-reads, finds the remote holding its own envelope byte-for-byte
and completes with nothing reported.

⚠️ Unchanged, and still a divergence hazard: a **local-only** instance (no sync
target) sharing the store marks nothing dirty, so its writes are never pushed
by a synced instance — only a `push({ full: true })` picks them up.
