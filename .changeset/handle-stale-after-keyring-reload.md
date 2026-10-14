---
"@noy-db/hub": patch
---

**A collection handle held across a pull that reloads your keyring went stale,
and stayed stale (family#192).** If a pull brought a newer copy of your own
`_keyring` file — any re-grant does — a `Collection` you were already holding
kept serving its pre-pull cache. A handle obtained *after* the pull was
correct, so the symptom was a stale read through the handle the surrounding
code was already using.

Two distinct faults behind one line:

- `_reloadKeyringAfterSync` called `collectionCache.clear()`, and the handle a
  caller holds **is** one of the objects in that map. core#122 found exactly
  this on the restore path and fixed it there; the fix never reached this one.
- ⛔ Invalidating-then-clearing — the obvious repair — is **not enough**.
  Per-record sync invalidation resolves its target through
  `collectionCache.get()`, so clearing the map orphans a held handle from it
  for the rest of its life: the handle reads correctly once and is stale again
  on the very next pull, with no keyring change involved.

Instances are now invalidated **in place** and stay registered, and
`Collection` resolves its DEK through the vault's *current* resolver rather
than one captured at construction — the key resolver is what actually went
stale, since the reload replaces the vault's while `Collection.getDEK` is
assigned once into a `readonly` field.

That last part fixes a second, quieter case: a handle acquired for a collection
**before** you had access to it now reads correctly once the granting pull
arrives, instead of throwing `NoAccessError` from a resolver bound to the
pre-pull keyring.

No API change.
