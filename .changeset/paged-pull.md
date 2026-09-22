---
'@noy-db/hub': minor
---

**`pull({ paged: true })`** (core#81, the other half): walk the remote one page at a time instead of one `loadAll()` — memory bounded by a page, and the total known BEFORE the first record is applied (one `list()` per collection), so `sync:progress` is real from the start. Uses the store's `listPage` when it offers one, else `list` + `get` in batches of 200.

⚠️ Scope, stated in the option's doc: the store contract cannot enumerate collections, so paged mode walks the collections this keyring names (its DEK map) plus any `collections` filter — the ones the caller can open. A full pull also carries ciphertext for collections the caller holds no key for; paged mode cannot. A `listCollections?` store extension is what would make paged the default; that is a `/to` seam change and is tracked by the family root. Default stays `false`.
