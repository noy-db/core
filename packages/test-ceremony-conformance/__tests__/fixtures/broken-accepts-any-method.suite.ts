// ⛔ A CONTROL. The kit must FAIL this fixture; `kit-contract.test.ts` spawns a
// child vitest over it and asserts which cases went red. The defect is
// `accepts-any-method` — see `ceremony.ts`.
import { runCeremonyConformanceTests } from '../../src/index.js'
import { METHOD, ceremony, oldSlot, wrongMethodSlot, unwrap } from './ceremony.js'

runCeremonyConformanceTests('broken ceremony — accepts-any-method', {
  method: METHOD,
  ceremony: () => ceremony('accepts-any-method'),
  oldSlot,
  wrongMethodSlot,
  unwrap,
})
