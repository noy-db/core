/**
 * `@noy-db/test-capsule-conformance` is now a re-export of `@noy-db/ports/capsule` — the six
 * conformance kits were consolidated into one package with one subpath per
 * hub port (2026-09-21). Function names are unchanged; only the specifier
 * moved. This name stays published for consumers still pinning it and is
 * deprecated in favour of `@noy-db/ports/capsule`.
 */
export * from '@noy-db/ports/capsule'
