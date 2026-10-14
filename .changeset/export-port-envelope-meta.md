---
"@noy-db/hub": patch
---

**`vault.export` can now ask for `envelopeMeta` (family#166, format-port
half).** `FormatExportOptions` gains `withEnvelopeMeta?: boolean`:

```ts
await vault.export(asSql(), { withEnvelopeMeta: true })
```

`exportStream({ withEnvelopeMeta: true })` shipped earlier and gives each
exported record its store-level `_v` and `_ts`. The format port had no way to
request it — `vault.export` never passed the flag — so a format ready to emit
write metadata received chunks without it and wrote NULLs. `@noy-db/as-sql`'s
`metadataColumns` is the reason this exists.

Off by default: it costs one extra store read per record on a scoped export.

⚠️ `ExportChunk.envelopeMeta` is **positional**, not keyed by id —
`envelopeMeta[i]` describes `records[i]`. A record need not carry an `id` field
at all, since hub's id is the store key rather than a property of the record,
so no keyed shape could be built for every collection. Redaction preserves the
alignment (it maps records 1:1), and that is now an asserted invariant rather
than an accident.

No new exports, so the `/as` subpath surface is unchanged.
