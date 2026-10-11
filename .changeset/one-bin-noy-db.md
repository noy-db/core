---
"create-noy-db": minor
"@noy-db/cli": minor
---

**One command line.** Every `noydb` command (`inspect`, `verify`, `describe`, `config`, `monitor`) now lives in `create-noy-db`'s `noy-db` bin, the one door after `npm create noy-db`. `@noy-db/cli` becomes a redirect: its `noydb` bin prints the new spelling and execs `noy-db`, and its programmatic exports re-export from `create-noy-db`. It is deprecated on npm at the stable 0.10.0.

`noy-db` verbs: `add`, `user add` (was `add user`), `user rotate` (was `rotate`), `backup`, `doctor crypto` (was `verify` — it collided with pod verify), `pod inspect`, `pod verify`, `describe`, `config validate|scaffold|profiles`, `monitor`, `inspect`. Old spellings keep working and print the new one once.

New: `noy-db config profiles` lists the ten topology profiles, and `config scaffold --help` is help. Until now every pointer went to `docs/guides/topology-matrix.md`, a path that existed in no public repo, so profiles B–J were undiscoverable from the CLI.

`noy-db inspect` reaches `@noy-db/in-devtools-tui` when it is installed in your project and names it when it is not. It is not a dependency: the TUI depends on a satellite, and core never imports back.
