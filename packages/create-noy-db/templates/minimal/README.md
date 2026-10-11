# {{PROJECT_NAME}}

The smallest [noy-db](https://github.com/noy-db/core) app: Vite + TypeScript, no framework. One file opens an encrypted vault in the browser and reads and writes typed records. Scaffolded by `create-noy-db`.

## Stack

- **Vite** — dev server + build
- **@noy-db/hub** — the zero-knowledge encrypted document store
- **{{ADAPTER_PACKAGE}}** — the storage adapter you chose (`{{ADAPTER}}`)

Everything stored is encrypted with AES-256-GCM before it reaches the adapter; the adapter only ever sees ciphertext.

## Getting started

```bash
pnpm install     # or npm/yarn/bun
pnpm dev         # http://localhost:5173
pnpm build       # production build in dist/
```

Open DevTools → Application → IndexedDB after adding a note: the stored values are ciphertext.

## Next steps

```bash
noy-db doctor                  # what is configured, and what is not yet (recovery, backups…)
noy-db add --list              # the landscape: stores, frameworks, unlock methods, exports
noy-db add @noy-db/in-vue      # for example — installs and wires a package
```

## Documentation

- [Start here](https://github.com/noy-db/docs/blob/main/content/docs/start/index.md)
- [Core concepts](https://github.com/noy-db/docs/blob/main/content/docs/core/index.md)
- [Architecture](https://github.com/noy-db/docs/tree/main/content/docs/architecture)
