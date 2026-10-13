---
"@noy-db/ports": patch
---

**`/to` conformance: a `saveAll` case-folding case (family#217).** The suite's
existing case-folding case exercises `put`, which is where a store usually
guards. `saveAll` is unguarded in a way `put` is not — because it REPLACES, it
also PRUNES — and on a case-insensitive filesystem that cost both records:

```
put('Abc')                   → Abc.json
saveAll({ coll1: { abc } })  → writes abc's body INTO the folded Abc.json,
                               then prunes `Abc`, because the snapshot says `abc`
list()      -> []              ← the record that existed is gone
get('abc')  -> null            ← and so is the one just written
```

Measured on APFS against `@noy-db/to-file@0.10.0-pre.2`; `@noy-db/to-file`
patched in the same cut.

The case asserts record **survival** before anything else, and captures the
outcome rather than requiring a throw. A store may refuse the snapshot or
represent both ids — the same latitude the `put` case grants — so requiring a
rejection would fail a conformant store that encodes case into its key. What no
store may do is accept the call and end up holding neither record.

⚠️ **For store authors:** if your store runs on a case-folding substrate and
does not already guard `saveAll`, this case will fail, and it is reporting real
data loss rather than a strictness change. Guarding every `saveAll` write (and
checking every path component, not only the leaf) is what `to-file` does;
refusing the snapshot in full, before writing any of it, keeps a refusal from
leaving a half-applied restore behind.
