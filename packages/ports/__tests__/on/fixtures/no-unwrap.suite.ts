// ⭐ NOT a failure case — the subject is the kit's LOUD SKIP.
//
// `unwrap` is optional, and the freshness case (6) cannot run without it. The
// kit's design decision is to keep the case and rename it, so the hole shows
// in the output instead of being inferred from a row count. That is a claim
// about the kit's own behaviour, so `kit-contract.test.ts` runs this suite,
// expects it GREEN, and asserts the skip is named in the output.
//
// ⚠️ Delete `unwrap` from a fixture and everything still passes. That is
// precisely why this is checked: the difference between "verified" and
// "unverified" here lives entirely in a test NAME.
import { runCeremonyConformanceTests } from '../../../src/on/index.js'
import { METHOD, ceremony, oldSlot, wrongMethodSlot } from './ceremony.js'

runCeremonyConformanceTests('synthetic ceremony, no unwrap supplied', {
  method: METHOD,
  ceremony: () => ceremony('none'),
  oldSlot,
  wrongMethodSlot,
})
