# @noy-db/shamir

## 0.9.0-pre.1

Lockstep bump to 0.9.0-pre.1; no package-level change in this release. See `@noy-db/hub` 0.9.0-pre.1 for the line's notes.

## 0.9.0-pre.0

Documented that a share does not identify the secret it splits: `combineSecret` validates length, count and distinct x-coordinates, never that the shares came from the same split, so K shares of a superseded split return the OLD secret. `share-format.ts` no longer describes a `shareId`/ULID prefix that never existed; the real prefix is `SHAMIR_S<x>_K<k>N<n>__`. Known-answer vectors (`__tests__/known-answer-vectors.test.ts`) can detect the consistent-error class a round-trip suite structurally cannot. No runtime change.

## 0.8.0

Lockstep bump to 0.8.0; no package-level change in this release. See `@noy-db/hub` 0.8.0 for the line's notes.

## 0.8.0-pre.0

Relicensed from MIT to Apache-2.0 from this version on. Earlier versions remain MIT.

## 0.7.1-pre.0

### Patch Changes

- **`@noy-db/shamir` (new):** Shamir Secret Sharing over GF(2^8) and the share codecs, extracted from `@noy-db/on-shamir` as a zero-dependency primitive with no hub contract. `@noy-db/on-shamir` now depends on this package and re-exports its surface; import from here when composing threshold sharing into something that is not a noy-db unlock method. Error messages are prefixed `shamir:`.

  **`@noy-db/hub`:** Hub's recovery tests no longer depend on `@noy-db/on-shamir`; they exercise the real k-of-n math through `@noy-db/shamir`. `packages/on-shamir` has left this repository for `vLannaAi/noy-db-on` — `@noy-db/on-shamir@0.7.0` is the last version published from here; later versions come from noy-db-on on its own line. No runtime change: `NoydbShamir` on `@noy-db/hub/on` is unchanged and is now the only declaration of that interface in the family. (Second half of #211.)
