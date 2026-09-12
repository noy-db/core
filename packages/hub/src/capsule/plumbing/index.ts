/**
 * `makeCapsule()` — hub's envelope plumbing, bound to one capsule's cipher.
 *
 * ⭐ WHY THIS EXISTS. `enclave-aes` is ~4,200 lines, but only ~1,200 touch
 * `crypto.subtle`. The other ~3,000 — envelope assembly, record-identity AAD,
 * tombstones, the record codec, sealed slots, rekeying — encode HUB'S ENVELOPE
 * FORMAT, not anyone's cipher, so they are identical for every capsule. This
 * module is the single copy; a capsule supplies {@link CapsulePrimitives} and
 * gets the whole surface back.
 *
 * The alternative was copying the plumbing into each capsule. Rejected because
 * nothing would fail when the copies drifted: a change to the tombstone shape
 * or the AAD would have to be made twice, and the miss surfaces as an envelope
 * one capsule writes and the other cannot read — at runtime, in a consumer.
 *
 * ⚠️ BINDING IS PER-CALL, NOT PER-PROCESS, and that is load-bearing. An
 * earlier sketch bound primitives once into module state (`setPrimitives(p)`),
 * which is simpler and wrong: the conformance kit runs two capsules in the
 * same process, so a single global would make the second one silently inherit
 * the first one's cipher — and both suites would still pass.
 *
 * Cipher-FREE helpers are NOT in here. They are plain exports of their own
 * modules (`buildRecordAad`, `isTombstone`, `hasSealedBody`, …) because they
 * inspect envelope fields and need nothing bound. Re-exported below so the
 * capsule surface stays one import for consumers.
 */
import type { CapsulePrimitives } from '../contract.js'
import { makeEnvelopeBody } from './envelope-body.js'
import { makeSealedSlot } from './sealed-slot.js'
import { makeSealedSlots } from './sealed-slots.js'
import { makeRecordCodec } from './record-codec.js'
import { makeLifecycle } from './lifecycle.js'
import { makeRekey } from './rekey.js'
import { makeRekeyBlob } from './rekey-blob.js'
import { makeSealing } from './sealing.js'
import { makeDeterministic } from './deterministic.js'

// ─── cipher-free plumbing, shared verbatim ────────────────────────────
export {
  buildRecordAad,
  recordAadFor,
  type RecordIdentity,
  type RecordRef,
} from './record-aad.js'
export { buildRecordEnvelope } from './record-envelope.js'
export {
  isTombstone,
  isTombstoneShape,
  buildTombstone,
  isDeleteMarker,
  buildDeleteMarker,
} from './tombstone.js'
export { normalizeForVerify } from './normalize.js'
export { parseSealedSlot } from './sealed-slot.js'
export {
  requireSealedBody,
  sealedBodyArgs,
  envelopeBodySize,
  hasPerRecordKey,
  envelopeBodyForHash,
  hasSealedBody,
} from './envelope-body.js'

/**
 * Bind the plumbing to a capsule's primitives.
 *
 * Composition order is a real dependency order, not a style choice:
 * `sealedSlot` feeds both `sealedSlots` and `sealing`; `sealedSlots` feeds the
 * codec. Everything else depends only on `p`.
 */
export function makeCapsule(p: CapsulePrimitives) {
  const sealedSlot = makeSealedSlot(p)
  const envelopeBody = makeEnvelopeBody(p)
  const sealedSlots = makeSealedSlots(p, sealedSlot)
  const codec = makeRecordCodec(p, sealedSlots)

  return {
    ...envelopeBody,
    ...sealedSlot,
    ...sealedSlots,
    ...codec,
    ...makeLifecycle(p),
    ...makeRekey(p),
    ...makeRekeyBlob(p),
    ...makeSealing(p, sealedSlot),
    ...makeDeterministic(p),
  }
}

/**
 * `RecordCodec` as a TYPE is the module-level generic base class; as a VALUE
 * it is the capsule-bound subclass `makeCapsule()` returns. Hub parameterises
 * the type in six places, and an `InstanceType<…>` alias would have dropped
 * `T` at every one of them without an error — see the note in
 * `record-codec.ts`.
 */
export type { RecordCodecBase as RecordCodec } from './record-codec.js'

export type Capsule = ReturnType<typeof makeCapsule>
