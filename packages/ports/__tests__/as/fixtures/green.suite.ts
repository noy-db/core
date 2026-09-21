// The kit's own contract, run against a synthetic format. Executed by a CHILD
// vitest from `kit-contract.test.ts`, which asserts this suite PASSES — the
// kit's first test of itself.
import { runFormatConformanceTests } from '../../../src/as/index.js'
import { fixtureFor } from './format.js'

runFormatConformanceTests('synthetic-csv', fixtureFor({ collections: ['invoices'] }))
