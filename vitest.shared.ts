/**
 * The one place a test timeout is decided in this repo.
 *
 * ## Why this file exists
 *
 * There were two budgets and neither was a decision. 24 packages carried
 * `testTimeout: 15_000` and 33 kept vitest's 5000ms default, both set in the
 * foundation commit, with no recorded reason and no relationship to how long
 * anything actually takes.
 *
 * Measured across a full green run — 1289 individual tests, timed. **10 of
 * them exceed the budget that actually applies to them**, in six packages:
 *
 *     8046ms /  5000   to-meter           degraded/restored transitions
 *     7071ms /  5000   hub                #691 verify doors, findByDigest
 *     6358ms /  5000   hub                listAccessibleVaults (leak check)
 *     6303ms /  5000   on-recovery        generateRecoveryCodeSet
 *     6265ms /  5000   hub                rotateRecovery replaces
 *     5748ms /  5000   hub                rotateRecovery count override
 *     5638ms /  5000   hub                recoverSecret auto-rotate
 *     5421ms /  5000   hub                listAccessibleVaults minRole
 *     5299ms /  5000   at-azure-keyvault  hub integration
 *     5102ms /  5000   at-gcp-kms         hub integration
 *
 * They passed only by winning the scheduling lottery. The "flaky timeouts"
 * filed as #1174 are the subset that lost it — `cross-vault > filters by
 * minRole` is on this list at **5421ms against a 5000ms budget**, so it was
 * never flaky: it was over budget on a healthy run.
 *
 * ⚠️ The first version of this table said FOURTEEN, and four of those were
 * wrong: as-zip's 17.1s interop vectors and hub's BlobSet chunking and
 * indexed-query tests carry PER-TEST overrides (`{ timeout: 30_000 }`,
 * `{ timeout: 60_000 }`) that beat the package config. Comparing a duration
 * against `vitest.config.ts` measures the wrong budget whenever a test sets
 * its own — the effective value wins, and it is not in the file being read.
 * Caught by noticing that as-zip's suite had been passing all day, which a
 * genuinely over-budget test could not have done.
 *
 * ## Why 30 seconds, and why that is not just a bigger number
 *
 * A timeout is a HANG DETECTOR, not a performance budget. It should sit well
 * clear of the slowest legitimate test so that tripping it means something.
 *
 * The same run measured the ceiling with a 60s probe: the slowest test in the
 * repo is **17.1 seconds** and nothing came near 60. So the standing worry —
 * that raising a timeout hides a real hang — is measured false here rather
 * than argued away. 30s is ~1.75x the slowest observed and ~4x hub's worst.
 *
 * A test that trips this is hung, not slow. Re-run it in isolation before
 * touching this number: every failure filed on #1174 passed alone.
 *
 * ## ⛔ The one case where that advice is not enough, and why `test:ci` caps
 * ##    turbo's concurrency (core#55)
 *
 * `pnpm test:ci` is `turbo run test --concurrency=4 -- --coverage`. **The `4`
 * is load-bearing and is not tidiness.** Without it, turbo runs one task per
 * core, each spawning a v8-instrumented vitest, and on an 8-core machine two
 * heavy hub tests blow this 30s budget non-deterministically — `#1360` IVF-flat
 * and `#1458`'s tsc-spawning join refusal.
 *
 * ⭐ It is CONTENTION, not instrumentation, and the difference decides the fix.
 * Measured: the IVF-flat test is **1.9s** uninstrumented, **2.8s** alone under
 * coverage, and **>30s** only inside the full run at default concurrency. At
 * `--concurrency=4` the whole suite is 76/76 green. So the ceiling this file's
 * 30s was calibrated against is still the real ceiling; nothing about the
 * calibration expired.
 *
 * ⛔ **So do NOT raise TEST_TIMEOUT_MS to make a coverage run green** — that
 * is raising a hang detector to absorb scheduling pressure, which is exactly
 * what the section above argues against. A starved test and a hung one would
 * then look the same for however long the new number is. Cap the parallelism
 * instead; that is the thing that is actually wrong.
 *
 * ⚠️ This was unmeasurable until core#55: `test:ci` passed `--coverage` while
 * `@vitest/coverage-v8` was in no manifest and no lockfile, so the script had
 * never once run.
 */
export const TEST_TIMEOUT_MS = 30_000
