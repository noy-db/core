// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts which cases went red. The defect is
// `per-instance-fence` — see `mesh.ts`.
import { runMeshConformanceTests } from '../../src/index.js'
import { meshPair } from './mesh.js'

runMeshConformanceTests('broken mesh — per-instance-fence', { pair: () => meshPair('per-instance-fence') })
