---
"create-noy-db": patch
---

`noy-db describe` now reports the package's own version in `_provenance.generatedBy` (family#124). It emitted `noy-db describe v0.1.0` from a local `const VERSION = '0.1.0'` that never moved, so provenance claimed `0.1.0` from a package shipping `0.10.0-pre.1`. The value is read from `package.json` via the wizard's existing `ownVersion()`, and the tool name is unchanged.

⚠️ For anything parsing this field: the prefix already changed from `noydb describe` to `noy-db describe` in **0.10.0-pre.1**, when the CLI's commands moved into one bin (family#114). That was not called out at the time. Parse the name and the version separately, or match on the `noy-db describe` prefix alone.

The two existing assertions matched `/generatedBy: noy-db describe/`, which passes against any version string — which is how a frozen constant survived nine releases. The test now compares the emitted version to `package.json`, so re-hardcoding it fails here instead of in a consumer's parser.
