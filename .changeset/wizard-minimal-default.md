---
"create-noy-db": minor
---

**The recommended door is now one file.** `npm create noy-db` asks *"Use the recommended setup?"* first; yes scaffolds the new `minimal` template — hub + browser storage, a single `main.ts` that opens a vault and reads and writes typed records — and nothing else is asked. "No" (or any explicit `--template` / `--adapter` flag) opens the full template, adapter and sample-data prompts as before. `--yes` defaults to `minimal` too. Until now the default was Nuxt 4 + Pinia (628 packages, ~2 min) while the README promised "nothing beyond hub" (family#115).

The other templates are unchanged. `nuxt-default`, `vite-vue`, `vanilla` and `electron` are all still selectable by name.

⚠️ What `minimal` costs today, measured: the production chunk is 326 kB minified / **95 kB gzip**, because `createNoydb` lives only on hub's root barrel and that barrel cannot shed the kernel's subsystems. That is hub's to change (family#120); the template imports exactly what it uses.
