---
"create-noy-db": patch
---

The library entry now finds its own package root by walking up to its `package.json`, instead of counting two directory levels from `import.meta.url` (family#216). It counted levels, and the count is only right for one of the three build entries.

`render.ts` is bundled (tsup, `splitting: false`), so it is inlined into each entry and `import.meta.url` is the **entry's** path, not this source file's. From `dist/bin/create.js` two levels up is the package root; from `dist/index.js` it is the package's **parent**. So every LIBRARY caller resolved outside the package: `bundledCatalog()` threw `ENOENT` on `node_modules/templates/catalog.json`, and `describeBundle()` threw reading `node_modules/package.json` for `_provenance.generatedBy`. The bins were unaffected, which is why it shipped.

Latent since the 0.8 base, not a new regression — family#124 widened the blast radius by making `describe` call `ownVersion()`, but it did not introduce the path computation.

⚠️ Found by docs (showcase 87, docs#38), which asserts the throw and restores the library call once this ships.

No unit test could catch this: from `src/wizard/render.ts` under vitest, two levels up **is** the package root, so the whole suite passed. The new test imports the BUILT `dist/index.js` and refuses to run without a build, with the bin entry as a control — it was never broken, so a change that fails it is measuring something else.
