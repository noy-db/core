// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts a non-zero exit. See `store.ts` for the
// single defect involved (saveAll merges instead of replacing).
import { runStoreConformanceTests } from '../../../src/to/index.js'
import { mergesOnSaveAll } from './store.js'

runStoreConformanceTests('broken store — saveAll merges', async () => mergesOnSaveAll())
