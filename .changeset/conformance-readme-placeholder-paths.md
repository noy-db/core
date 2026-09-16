---
'@noy-db/test-adapter-conformance': patch
'@noy-db/test-capsule-conformance': patch
'@noy-db/test-format-conformance': patch
---

**Each kit's README showed the reader importing their own implementation from `'../src/index.js'` — a path that names the KIT's own source.**

In the reader's tree that path is theirs and the example reads correctly. Compiled inside the kit's own package it resolves to the kit's `src/index.ts`, which of course exports no `toMyBackend` / `asMyformat` / `download` / `write`, and no capsule module assignable to `CapsuleUnderTest`.

Now `'./my-backend.js'`, `'./my-capsule.js'` and `'./my-format.js'` — unmistakably the reader's own file, and no longer a path that claims to be ours.

Found by running the family's prose gate from the rail against this tree. Core's own gate misses it by accident of where its probe sits: at the repo root, `'../src/index.js'` resolves to nothing, becomes an ignored `TS2307`, and the block passes having checked nothing.
