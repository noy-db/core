---
"create-noy-db": patch
---

Four wizard defects measured on the shipped scaffolder (family#108):

- The Nuxt template's README named `@noy-db/{{ADAPTER}}` → `@noy-db/browser`, a package that does not exist. It now names the real one (`@noy-db/to-browser-idb`, `@noy-db/to-file`, or `@noy-db/hub` for the built-in memory store) via a new `ADAPTER_PACKAGE` token.
- `--yes` printed nothing — not even `cd` / `pnpm install` / `pnpm dev` — while `--help` advertised it. The next steps now print in both modes.
- The sync-adapter prompt is gone: no template consumed the answer. `--sync` is still parsed and carried in the result so a template can.
- Every generated README linked four docs under `noy-db/core/blob/main/docs/`, which does not exist; they now point at pages that do. `ROADMAP.md` links are removed (it is not published).
