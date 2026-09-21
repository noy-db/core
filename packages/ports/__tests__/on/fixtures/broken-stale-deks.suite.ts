// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts which cases went red. The defect is
// `stale-deks` — see `ceremony.ts`.
import { runCeremonyConformanceTests } from '../../../src/on/index.js'
import { METHOD, ceremony, oldSlot, wrongMethodSlot, unwrap } from './ceremony.js'

runCeremonyConformanceTests('broken ceremony — stale-deks', {
  method: METHOD,
  ceremony: () => ceremony('stale-deks'),
  oldSlot,
  wrongMethodSlot,
  unwrap,
})
