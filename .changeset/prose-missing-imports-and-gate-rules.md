---
'@noy-db/by-peer': patch
'@noy-db/in-pinia': patch
'@noy-db/in-nuxt': patch
---

**Three shipped examples named a symbol they never imported, and the gate that should have caught them was ignoring exactly that case.**

`check-prose-examples` treated every `TS2304 Cannot find name` as a property of the probe — an illustrative snippet legitimately eliding a variable. That exemption also swallowed the opposite case: a name **we publish**, used with no import, which a reader copying the block cannot run.

Raised by the `noy-db/on` silo (family#26) from `on-shamir`'s README calling `encodeShareBase32` un-imported. The same class was then measured here.

⛔ **The preamble convention cannot fix this class, which is why it needed its own rule.** An honest preamble for such a file would have to `declare const withSync` — documenting an ambient that is not ambient, and cementing the defect. A name the family exports is a **missing import**.

The gate now resolves every published entry point's `.d.ts` and treats a `TS2304`/`TS2552` naming one of those symbols as a finding. Reader-supplied values (`userSecret`, `opts`, `mockClient`) are absent from that set and stay exempt, so the exemption is **narrowed**, not removed.

Three defects fixed, all shipped:

- **`@noy-db/by-peer`** — the quickstart called `withSync()`, a real export of `@noy-db/hub/sync`, in a block already carrying three imports. The prose two lines below said where it comes from; the block did not, and a reader copying it gets `withSync is not defined`.
- **`@noy-db/in-pinia`** — the schema-validation example called `defineNoydbStore`, the package's own primary export, in a block that opens with `import { z } from 'zod'`. Because the block has an import, the file's preamble did not apply to it.
- **`@noy-db/in-nuxt`** — `computed` in the SFC examples is **Vue's**, auto-imported inside `<script setup>`, and `@noy-db/hub` exports a via-field descriptor of the same name. The names genuinely collide, and a reader resolving it the other way gets a field descriptor where they wanted reactivity. Now declared in the preamble against Vue's, with the collision stated.

Also in the root README: the `to-` row advertised *"5 essentials"* including `to-probe`, which was **retired** — absorbed into `toMeter()` (#845) and still resolving on npm at `0.3.0`, which is what stopped it reading as stale. Core has four.
