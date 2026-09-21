// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts a non-zero exit. See `store.ts` for the
// single defect involved (tx() undeclared).
import { runStoreConformanceTests } from '../../../src/to/index.js'
import { undeclaredTx } from './store.js'

runStoreConformanceTests('broken store — tx() undeclared', async () => undeclaredTx())
