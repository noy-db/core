/**
 * The suite, run against a conforming synthetic ceremony (core#46).
 *
 * ⛔ WHY THIS PACKAGE HAD NO TEST AT ALL. Its `include` pointed at `src/`,
 * where it has never had a test file, and its script passed
 * `--passWithNoTests` — so the job went green having collected nothing, and it
 * shipped that way in `0.0.0-dev-20260917060654`.
 *
 * ⚠️ There is no ceremony in THIS repo to bind: `on-password` and
 * `on-webauthn` both live in `noy-db/on`, on their own version line, and a kit
 * reaching across repos for its own self-test is not a shape this family has.
 * So the reference is synthetic — see `fixtures/ceremony.ts` — and it is also
 * the baseline its own controls are measured against: without it green, a red
 * control would not attribute.
 *
 * ⚠️ Green here proves the kit can PASS. `kit-contract.test.ts` is the half
 * that proves it can FAIL, and neither is worth much alone.
 */
import { runCeremonyConformanceTests } from '../src/index.js'
import { METHOD, ceremony, oldSlot, wrongMethodSlot, unwrap } from './fixtures/ceremony.js'

runCeremonyConformanceTests('synthetic wrap-DEKs ceremony', {
  method: METHOD,
  ceremony: () => ceremony('none'),
  oldSlot,
  wrongMethodSlot,
  unwrap,
})
