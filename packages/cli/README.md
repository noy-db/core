# @noy-db/cli — deprecated, redirects to `noy-db`

[![npm](https://img.shields.io/npm/v/%40noy-db/cli.svg)](https://www.npmjs.com/package/@noy-db/cli)

Every command this package carried now lives in [`create-noy-db`](https://www.npmjs.com/package/create-noy-db)'s **`noy-db`** bin — the one command line after `npm create noy-db`.

```bash
pnpm add -D create-noy-db
noy-db --help
```

| was | now |
|---|---|
| `noydb inspect <file.noydb>` | `noy-db pod inspect <file.noydb>` |
| `noydb verify <file.noydb>` | `noy-db pod verify <file.noydb>` |
| `noydb describe <file.noydb>` | `noy-db describe <file.noydb>` |
| `noydb config validate <file>` | `noy-db config validate <file>` |
| `noydb config scaffold --profile=<id>` | `noy-db config scaffold --profile=<id>` (and `noy-db config profiles` lists them) |
| `noydb monitor <file>` | `noy-db monitor <file>` |

While installed, `noydb <cmd>` prints the new spelling and runs it for you. Programmatic imports (`import { describeBundle } from '@noy-db/cli'`) keep resolving; import from `create-noy-db` instead.

## Documentation

- Main repository — [noy-db/core](https://github.com/noy-db/core#readme)
- Source — [`packages/cli`](https://github.com/noy-db/core/tree/main/packages/cli)
