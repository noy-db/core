/**
 * The AES capsule, assembled: hub's shared plumbing bound to `aesPrimitives`.
 *
 * `classify/**` stays capsule-private (it is an optional group an exclave
 * refuses) but still needs `dualReadSealedSlot`, which is plumbing. Binding it
 * once here keeps `reveal.ts`/`verify.ts` from each building their own copy —
 * two bindings of the same primitives would work, but they would be two
 * objects, and `instanceof` across them is the class of bug the Stage B door
 * test caught by asserting identity rather than names.
 */
import { makeCapsule } from '../plumbing/index.js'
import { aesPrimitives } from './primitives.js'

export const aesCapsule = makeCapsule(aesPrimitives)
export const { dualReadSealedSlot } = aesCapsule
