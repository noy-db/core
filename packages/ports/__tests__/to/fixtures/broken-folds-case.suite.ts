// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts a non-zero exit. See `store.ts` for the
// single defect involved (ids fold case-insensitively and saveAll prunes by the
// snapshot's unfolded keys, so both records are lost — family#217).
import { runStoreConformanceTests } from '../../../src/to/index.js'
import { foldsCaseAndPrunes } from './store.js'

runStoreConformanceTests('broken store — folds case on saveAll', async () => foldsCaseAndPrunes())
