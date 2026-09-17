// ⭐ NOT a failure case — the subject is the kit's LOUD SKIP, and this is the
// path EVERY existing as-* fixture takes on upgrade: `scope` is optional, so a
// fixture that predates core#43 stays green.
//
// What must not happen is that it stays green SILENTLY. The kit keeps a case
// and renames it, so an unverified scope is distinguishable from a verified one
// by reading the run. That distinction lives entirely in a test NAME — nothing
// fails if it regresses — which is why `kit-contract.test.ts` asserts it from
// outside, with a verbose reporter.
import { runFormatConformanceTests } from '../../src/index.js'
import { fixtureFor } from './format.js'

const { scope: _dropped, ...noScope } = fixtureFor({ collections: ['invoices'] })

runFormatConformanceTests('synthetic-csv (no scope declared)', noScope)
