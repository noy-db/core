/**
 * The classify VERIFY oracle — plumbing, not cipher (family#168).
 *
 * ⭐ WHY IT LIVES HERE. Every line below is hub's verify PROTOCOL: the C4
 * timing pad, the R6 residue refusal, the `_tier > 0` non-comparability rule,
 * the k-of-n denominator. None of it chooses a cipher. What it needs from a
 * capsule is four functions — `pbkdf2VerifyDigest`, `blindedEqual`,
 * `openVdigPayload` and the bound `dualReadSealedSlot` — and family#168
 * promoted the first two to {@link CapsulePrimitives} precisely so this module
 * could stop living inside `enclave-aes/classify/`.
 *
 * ⛔ IT WAS NOT A CARVE-OUT, IT WAS A MISSING PRIMITIVE. Until family#168 the
 * four orchestrators below were reached by `via/classified/active.ts` and
 * `kernel/collection.ts` through a dynamic `import()` straight past the
 * enclave barrel, grandfathered in `DYNAMIC_ENCLAVE_BYPASS`. A build whose
 * `#capsule` resolves to another capsule still loaded THESE engines bound to
 * the REFERENCE cipher — the swap silently did not reach the verify oracle.
 * Nothing failed, because the engines happened to be correct for AES.
 *
 * ⚠️ LAZINESS IS THE CALLER'S, AND IT MOVED. `makeCapsule()` binds these
 * through a thunk that `import()`s this module on first call, so opting into
 * `withClassified()` does not drag a PBKDF2 oracle into every bundle. The
 * bundle gate's `classified` scenario measures that; its comments used to say
 * the laziness lived at `active.ts`'s dynamic import, which is no longer true.
 * @module
 */
import { VDIG_ITERATIONS, type CapsuleKey, type CapsulePrimitives, type VdigPayload } from '../contract.js'
import { generateSalt, base64ToBuffer } from './digest.js'
import { normalizeForVerify, type VerifyNormalizeMode } from './normalize.js'
import { evaluateKofN } from './kofn.js'
import { ClassifiedConfigError, ClassifiedVerifyError } from '../../kernel/errors.js'
import type { EncryptedEnvelope, VdigFieldPolicy, ClassifiedVerdict } from '../../kernel/types.js'

/** What the verify engines need from the bound capsule. */
export interface ClassifyVerifyDeps {
  readonly pbkdf2VerifyDigest: CapsulePrimitives['pbkdf2VerifyDigest']
  readonly blindedEqual: CapsulePrimitives['blindedEqual']
  readonly openVdigPayload: CapsulePrimitives['openVdigPayload']
  readonly dualReadSealedSlot: (
    blob: string, field: string, collection: string, cek: CapsuleKey | undefined, dek: CapsuleKey,
  ) => Promise<string>
}

export interface VerifyEngineCtx {
  readonly collection: string
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<CapsuleKey | undefined>
  getDEK(): Promise<CapsuleKey>
  readonly now: () => number
}

/**
 * C4 pad: one full-cost dummy digest + one dummy compare; result discarded.
 * Pad at `iter` when the caller holds an AUTHENTICATED payload.iter, so pad
 * cost tracks the real compare cost across future iteration bumps; the
 * fully-absent paths (no payload to read an iter from) use VDIG_ITERATIONS.
 */
async function padOnce(d: ClassifyVerifyDeps, iter: number = VDIG_ITERATIONS): Promise<void> {
  const dummy = await d.pbkdf2VerifyDigest('noydb-classify-c4-pad', generateSalt(), iter)
  await d.blindedEqual(dummy, dummy)
}

async function padFalse(d: ClassifyVerifyDeps): Promise<ClassifiedVerdict> {
  await padOnce(d)
  return { ok: false }
}

/** R6 verify-side transition evidence — config bug, fail-loud, pad-exempt. */
function refuseSealedResidue(collection: string, field: string): never {
  throw new ClassifiedConfigError(collection,
    `field "${field}" carries a recoverable _sealed slot but no _vdig — storage-form ` +
    `transition detected (R6); refused fail-loud, never an ok:false masquerading as wrong-password`)
}

export async function verifyDigestField(
  d: ClassifyVerifyDeps,
  ctx: VerifyEngineCtx,
  id: string,
  field: string,
  candidate: string,
  policy: VdigFieldPolicy,
): Promise<ClassifiedVerdict> {
  const env = await ctx.getEnvelope(id)
  // #691: an elevated envelope (_tier > 0) is non-comparable through every
  // tier-0 door — its key material is tier-DEK-wrapped and must never be
  // resolved here (the elevating session's warm cekCache would otherwise
  // leak past the tier audit). Exactly the missing-record pad path, checked
  // BEFORE the R6 residue probe so tier-0 callers learn nothing.
  if (env === null || (env._tier ?? 0) > 0) return padFalse(d)
  const blob = env._vdig?.[field]
  if (blob === undefined) {
    if (env._sealed?.[field] !== undefined) refuseSealedResidue(ctx.collection, field)
    return padFalse(d)
  }
  const cek = await ctx.resolveCek(env)
  if (cek === undefined) return padFalse(d)

  let payload: VdigPayload
  try {
    payload = await d.openVdigPayload(blob, cek, ctx.collection, id, field)
  } catch {
    return padFalse(d) // AAD/tamper (C1) → padded false; no tamper oracle to the caller
  }

  const normalized = normalizeForVerify(policy.normalize, candidate)
  const digest = await d.pbkdf2VerifyDigest(normalized, base64ToBuffer(payload.cur.salt), payload.iter)
  const ok = await d.blindedEqual(digest, base64ToBuffer(payload.cur.hash))
  if (!ok) return { ok: false } // I1: bare false — mustRotate never computed here

  if (policy.rotateDays !== undefined
    && ctx.now() > Date.parse(payload.cur.at) + policy.rotateDays * 86_400_000) {
    // Disclosing write-age-vs-policy to a SUCCESSFUL verifier is intended (audit F6).
    return { ok: true, mustRotate: true }
  }
  return { ok: true }
}

export async function verifyTextField(
  d: ClassifyVerifyDeps,
  ctx: VerifyEngineCtx,
  id: string,
  field: string,
  candidate: string,
  normalize: VerifyNormalizeMode,
): Promise<ClassifiedVerdict> {
  // C4, single code path: (a) attempt the unseal where a slot exists, then
  // for EVERY outcome — present-correct, present-wrong, missing record,
  // missing slot, tampered — (b) run the one constant-cost pad, (c) run one
  // blindedEqual, (d) return the boolean. Unlike the digest door there is no
  // real PBKDF2 here (unseal is sub-ms AES-GCM), so skipping the pad on the
  // real compare would make exists-but-wrong ~100x FASTER than absent — an
  // inverted existence oracle. No branch below skips the dominant cost.
  const env = await ctx.getEnvelope(id)
  const blob = env?._sealed?.[field]
  let stored: string | undefined
  if (env !== null && (env._tier ?? 0) === 0 && blob !== undefined) { // #691: elevated ≡ missing
    const cek = await ctx.resolveCek(env)
    const dek = await ctx.getDEK()
    try {
      // Plaintext exists microseconds inside this function; only the boolean leaves.
      stored = String(JSON.parse(await d.dualReadSealedSlot(blob, field, ctx.collection, cek, dek)))
    } catch {
      stored = undefined // AAD/tamper (C1) → same padded compare tail as absent
    }
  }
  await padOnce(d)
  const a = new TextEncoder().encode(normalizeForVerify(normalize, candidate))
  const b = stored !== undefined
    ? new TextEncoder().encode(normalizeForVerify(normalize, stored))
    : a // no-compare dummy comparand — the verdict is forced false below
  const eq = await d.blindedEqual(a, b)
  return { ok: stored !== undefined && eq }
}

export async function matchGroupFields(
  d: ClassifyVerifyDeps,
  ctx: VerifyEngineCtx,
  id: string,
  answers: Record<string, string>,
  members: ReadonlyArray<{ readonly field: string; readonly policy: VdigFieldPolicy }>,
  opts: { readonly min: number },
): Promise<{ readonly passed: boolean }> {
  // I2 step 1 — validate EVERYTHING up front, before any PBKDF2, throwing
  // uniformly at ~0 elapsed (no member-position leak via timing/throw type).
  if (!Number.isInteger(opts.min) || opts.min < 1 || opts.min > members.length) {
    throw new ClassifiedVerifyError(ctx.collection, '*',
      `matchGroup min ${opts.min} out of range 1..${members.length}`)
  }
  const normalized = new Map<string, string>()
  for (const m of members) {
    const answer = answers[m.field] // non-member answer keys: silently ignored
    if (answer === undefined) continue
    if (typeof answer !== 'string') {
      throw new ClassifiedVerifyError(ctx.collection, m.field, 'candidate must be a string')
    }
    normalized.set(m.field, normalizeForVerify(m.policy.normalize, answer))
  }

  const fetched = await ctx.getEnvelope(id)
  // #691: elevated ≡ missing — nulling the view here also skips the R6
  // residue probe (a tier-0 caller must not learn an elevated record's
  // storage form) and forces the cek-undefined pad path for every member.
  const env = fetched === null || (fetched._tier ?? 0) > 0 ? null : fetched
  if (env !== null) {
    for (const m of members) { // R6 evidence — uniform, before any PBKDF2
      if (env._sealed?.[m.field] !== undefined && env._vdig?.[m.field] === undefined) {
        refuseSealedResidue(ctx.collection, m.field)
      }
    }
  }
  const cek = env !== null ? await ctx.resolveCek(env) : undefined

  // I2 step 2+3 — iterate RESOLVED GROUP MEMBERS (denominator = |members|),
  // evaluate EVERY member (collect, never break), pad every no-compare slot.
  const results: boolean[] = []
  for (const m of members) {
    const candidate = normalized.get(m.field)
    const blob = env?._vdig?.[m.field]
    if (env === null || cek === undefined || blob === undefined) {
      await padOnce(d)
      results.push(false)
      continue
    }
    try {
      const payload = await d.openVdigPayload(blob, cek, ctx.collection, id, m.field)
      if (candidate === undefined) {
        // Slot present, answer absent: the payload's authenticated iter is in
        // hand — pad at IT (not the constant) so a future iteration bump
        // cannot desync this pad's cost from the real compare's cost.
        await padOnce(d, payload.iter)
        results.push(false)
        continue
      }
      const digest = await d.pbkdf2VerifyDigest(candidate, base64ToBuffer(payload.cur.salt), payload.iter)
      results.push(await d.blindedEqual(digest, base64ToBuffer(payload.cur.hash)))
    } catch {
      await padOnce(d)
      results.push(false)
    }
  }
  // Per-member results never appear in any return, error, or audit payload.
  return { passed: evaluateKofN(results, opts.min) }
}
