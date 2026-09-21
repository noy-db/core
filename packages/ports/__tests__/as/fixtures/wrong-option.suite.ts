// ⛔ THE CONTROL for the scope case, and the reason core#43 exists: a fixture
// that calls its own package with an option the package no longer reads.
//
// `collection` was renamed to `collections` when the read moved into hub.
// as-csv's conformance fixture kept passing the old name and **18 tests passed
// before the fix and 18 after** — every case asserts the gate FIRED, and a call
// with `collections: undefined` fires it exactly as well as a correct one.
//
// The kit must now go RED here: the option is dropped, the export widens to
// every collection, and `format.encode` receives both. `kit-contract.test.ts`
// spawns a child vitest over this and reads that failure as evidence.
import { runFormatConformanceTests } from '../../../src/as/index.js'
import { fixtureFor, driftedScope } from './format.js'

runFormatConformanceTests('synthetic-csv (drifted option name)', fixtureFor(driftedScope))
