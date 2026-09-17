// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts a non-zero exit. See `store.ts` for the
// single defect involved (drops _del).
import { runStoreConformanceTests } from '../../src/index.js'
import { dropsDeleteMarker } from './store.js'

runStoreConformanceTests('broken store — drops _del', async () => dropsDeleteMarker())
