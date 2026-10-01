---
"@noy-db/cli": minor
---

`noydb monitor` no longer wraps the config's store in `toMeter()` — it now requires a store that is already metered, and reports an error naming the fix when it is not. Wrap it in the config file instead: `store: toMeter(inner, { degradedMs: 500 })`, which is also where `onDegraded` / `onRestored` now live.

`@noy-db/to-meter` is gone from `@noy-db/cli`'s dependencies entirely, peer and dev, ahead of to-meter moving to `noy-db/to`: core publishes before its satellites, so a dependency here would be a publish-order back-edge. `MeterSnapshot` is replaced by cli's own structural `MeterSnapshotView`, which a real snapshot satisfies.
