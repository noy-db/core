// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts a non-zero exit. See `store.ts` for the
// single defect involved (collapses `..`, so an id climbs out of its vault).
import { runStoreConformanceTests } from '../../../src/to/index.js'
import { escapesNamespace } from './store.js'

runStoreConformanceTests('broken store — collapses `..` out of the vault', async () => escapesNamespace())
