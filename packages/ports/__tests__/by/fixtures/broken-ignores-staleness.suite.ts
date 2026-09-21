// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts which cases went red. The defect is
// `ignores-staleness` — see `mesh.ts`.
import { runMeshConformanceTests } from '../../../src/by/index.js'
import { meshPair } from './mesh.js'

runMeshConformanceTests('broken mesh — ignores-staleness', { pair: () => meshPair('ignores-staleness') })
