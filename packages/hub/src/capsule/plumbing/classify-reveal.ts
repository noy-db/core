/**
 * Single-point audited reveal — plumbing, not cipher (family#168).
 *
 * Decrypt ONE sealed slot from the raw envelope: no full record view, no
 * `collection.get()`, so no spurious 'get' consent entry. Fail-closed gates
 * (b)/(c) live here; gate (a) (`storage:'never'`) fires in `collection.reveal`
 * before any strategy call.
 *
 * ⭐ The only capsule-bound thing it touches is `dualReadSealedSlot`, which is
 * already plumbing (`sealed-slot.ts`) — so this module was inside
 * `enclave-aes/classify/` for no reason anyone could name, and
 * `via/classified/active.ts` reached it with a dynamic import past the barrel.
 * See `classify-verify.ts`'s header for what that cost.
 * @module
 */
import type { CapsuleKey } from '../contract.js'
import type { ClassifyVerifyDeps } from './classify-verify.js'
import { isTombstone } from './tombstone.js'
import { ClassifiedRevealError } from '../../kernel/errors.js'
import type { EncryptedEnvelope } from '../../kernel/types.js'

/** Reveal needs ONLY the dual-read — spelled as a slice of the verify deps so
 *  `makeCapsule()` binds one object for both engines. */
export type ClassifyRevealDeps = Pick<ClassifyVerifyDeps, 'dualReadSealedSlot'>

export interface RevealEngineCtx {
  readonly collection: string
  readonly encrypted: boolean
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<CapsuleKey | undefined>
  getDEK(): Promise<CapsuleKey>
}

export async function revealSealedField(
  d: ClassifyRevealDeps,
  ctx: RevealEngineCtx,
  id: string,
  field: string,
): Promise<unknown> {
  const env = await ctx.getEnvelope(id)
  if (env === null || isTombstone(env, ctx.encrypted) || (env._tier ?? 0) > 0) {
    throw new ClassifiedRevealError(ctx.collection, field, `record "${id}" not found in "${ctx.collection}"`)
  }
  if (!ctx.encrypted) {
    // Plaintext collection: nothing is sealed; the value sits in the open body.
    const record = JSON.parse(env._data || '{}') as Record<string, unknown>
    if (!(field in record)) {
      throw new ClassifiedRevealError(ctx.collection, field, `no stored value for "${field}"`)
    }
    return record[field]
  }
  const blob = env._sealed?.[field]
  if (blob === undefined) {
    // Gate (c): fail-closed error, never parseSealedSlot(undefined)'s TypeError.
    throw new ClassifiedRevealError(ctx.collection, field, `no sealed value stored for "${field}"`)
  }
  const cek = await ctx.resolveCek(env)
  const dek = await ctx.getDEK()
  return JSON.parse(await d.dualReadSealedSlot(blob, field, ctx.collection, cek, dek))
}
