---
"create-noy-db": minor
---

`noy-db doctor` now reports the two ways a satellite's checks could previously fail to run in silence (family#123). A package whose `.` export resolves to nothing importable — a CJS-only condition — is reported as `NOY-D006` (info, since most packages ship no checks at all, so this is "not scannable", never "broken"). A package with no `.` export at all is subpath-only by design, like `@noy-db/ports`, and stays silent: there is nothing to scan and nothing for its author to fix. An entry in `noydbDoctorChecks` that is not a check, lacking a string `id` or a `run` function, is reported as `NOY-D007` (warn) instead of being dropped by the shape filter. A package that throws on import was already `NOY-D003`; the other two were bare `continue`s, which made the first adopter's likeliest mistake the one the tool could not report.

`--no-satellites` is now a flag, and `--help` states that doctor imports every installed `@noy-db/*` dependency except hub to collect the checks it exports — so it runs code from your `node_modules`. The behaviour is unchanged and the programmatic `noSatellites` option already existed; what was missing was any way to say so, or to opt out, from the CLI.

⚠️ `NOY-D007` is a warn, so a CI job pinned at `--fail-level=warn` can newly exit 1 — against a satellite that was shipping a broken check all along.
