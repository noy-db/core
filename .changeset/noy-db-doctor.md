---
"create-noy-db": minor
---

**`noy-db doctor`** — readiness checks that need no secret (family#116). Stable ids per group (`NOY-S` secret · `NOY-R` recovery · `NOY-T` topology · `NOY-C` capsule · `NOY-D` dependencies · `NOY-H` hygiene), three levels, a fix hint on every finding, `--mode dev|prod` (the same finding can be a warn in dev and an error in prod), `--json`, `--fail-level` **defaulting to error and saying so in `--help`**, and `--fix` for the idempotent fixes (today: gitignore `.env`). It reads the project's config through the same loader as `config validate` and the vault's public rows (`_keyring` listing, `_meta/recovery-*`) through the config's own store; it never derives a key.

A satellite contributes checks by exporting `noydbDoctorChecks: DoctorCheck[]` from its root entry. `noy-db doctor crypto` is the former `noy-db verify`.
