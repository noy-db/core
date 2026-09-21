// ⛔ THE CONTROL for the green suite: a fixture that omits `observableVault`.
// The kit must FAIL it with the migration message rather than silently falling
// back to the weaker lexical observation. Without this, a green run of
// green.suite.ts would only show that the kit CAN pass — not that it can fail.
import { runFormatConformanceTests } from '../../../src/as/index.js'
import { fixtureFor } from './format.js'

const { observableVault: _dropped, ...unobservable } = fixtureFor({ collections: ['invoices'] })

runFormatConformanceTests('synthetic-csv (no observableVault)', unobservable)
