/**
 * The AES capsule, assembled: hub's shared plumbing bound to `aesPrimitives`.
 *
 * One binding, for the whole capsule. `makeCapsule()` binds per call by design,
 * so calling it twice would produce two working-but-distinct objects, and
 * `instanceof` across them silently stops matching — the class of bug the
 * Stage B door test catches by asserting identity rather than names.
 *
 * ⚠️ It used to also re-export `dualReadSealedSlot`, for `classify/reveal.ts`
 * and `classify/verify.ts` to share. Those two moved into
 * `capsule/plumbing/classify-{reveal,verify}.ts` in family#168 and take the
 * dual-read as a bound dep instead, so nothing capsule-private needs it any
 * more. `knip` is what noticed; the export would otherwise have sat here as a
 * second public way into the plumbing.
 */
import { makeCapsule } from '../plumbing/index.js'
import { aesPrimitives } from './primitives.js'

export const aesCapsule = makeCapsule(aesPrimitives)
