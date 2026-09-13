/**
 * Enclave body helpers — the C1 protected-body access contract.
 *
 * `EncryptedEnvelope` splits into a protocol header (family-owned; `_noydb`,
 * `_v`, `_ts`, `_by`, `_source`, `_sourceTs`, `_tier`, `_elevatedBy`) and a
 * protected body (enclave-owned; `_iv`, `_data`, `_cek`, `_det`, `_sealed`,
 * `_debug`). The four helpers below are the ONLY sanctioned way for code
 * outside `capsule/enclave-aes/**` to read or construct the protected body —
 * later migration batches move the ~121 direct `_iv`/`_data`/`_cek`/`_sealed`
 * access sites in `with-*` services onto these.
 *
 * Each helper reproduces an EXISTING behavior byte-for-byte (see the
 * per-function doc for its oracle call site) — this file introduces no new
 * crypto or semantics, only a narrower door onto what already runs.
 */
import { buildRecordAad, recordAadFor, type RecordIdentity, type RecordRef } from './record-aad.js'
import type { CapsuleKey, CapsulePrimitives } from '../contract.js'
import type { EncryptedEnvelope } from '../../kernel/types.js'
import { MissingEnvelopeBodyError } from '../../kernel/errors.js'

/**
 * The sealed body, or a typed refusal (#15).
 *
 * Since `_iv`/`_data` became optional, every AES path that is about to call
 * `decrypt()` needs this one narrowing. It is deliberately the ONLY place in
 * the enclave that turns absence into an error: the alternative — a `!` or a
 * `?? ''` at each of the two dozen decrypt sites — would have spelled the
 * same decision twenty-four times and produced an AEAD failure (i.e. hub's
 * tamper alert) instead of an honest one.
 *
 * Ask {@link hasSealedBody} FIRST when absence is a legitimate outcome; this
 * helper is for the paths where it is not.
 */
export function requireSealedBody(
  env: Pick<EncryptedEnvelope, '_iv' | '_data'>,
  where: string,
): { iv: string; data: string } {
  if (env._iv === undefined || env._data === undefined) throw new MissingEnvelopeBodyError(where)
  return { iv: env._iv, data: env._data }
}

/**
 * {@link requireSealedBody} shaped for the `decrypt(iv, data, …)` argument
 * list, so a narrowing can be spliced into an existing call without
 * restructuring the statement around it:
 *
 * ```ts
 * await decrypt(...sealedBodyArgs(env, 'rekeyRecord'), dek, aad)
 * ```
 *
 * The tuple return type is load-bearing — it is what lets the spread satisfy
 * two fixed positional parameters. Widening it to `string[]` would compile
 * here and fail at every call site.
 */
export function sealedBodyArgs(
  env: Pick<EncryptedEnvelope, '_iv' | '_data'>,
  where: string,
): [string, string] {
  const { iv, data } = requireSealedBody(env, where)
  return [iv, data]
}

/**
 * Approximate protected-body payload size for KPI/telemetry (#807's
 * period-scoped pull download counters): `_data` + `_iv` string length —
 * ≈ ciphertext bytes for base64 payloads, exact for plaintext (`_iv: ''`)
 * collections. A measuring door, not a crypto one: callers get a size
 * without touching the protected fields directly.
 */
export function envelopeBodySize(env: EncryptedEnvelope): number {
  // An absent field meters as 0, the same as the emptied spelling it replaces
  // (#15) — a bodyless row has no payload to bill for, and throwing a
  // TypeError out of a telemetry counter would take down the write path.
  return (env._data?.length ?? 0) + (env._iv?.length ?? 0)
}

/**
 * Discriminant: does this envelope carry a per-record key?
 *
 * Replaces raw `envelope._cek !== undefined` checks scattered across
 * services — `_cek` presence is the format discriminant (see
 * `record-codec.ts`'s `resolveEnvelopeCek` doc).
 */
export function hasPerRecordKey(env: EncryptedEnvelope): boolean {
  return env._cek !== undefined
}

/**
 * Canonical body string for the ledger hash chain — the exact bytes
 * `with-commit/history/ledger/hash.ts`'s `envelopePayloadHash` derives from
 * `_data` + `_sealed` + `_vdig` + `_bidx` before hashing:
 *  - no `_sealed`, no `_vdig`, no `_bidx` → `_data` alone (back-compat: every
 *    pre-existing ledger entry and non-sealed backup hashes byte-identically).
 *  - any map present → canonical JSON of `{ _data, _sealed?, _vdig?, _bidx? }`
 *    with sorted keys at every level, each map bound ONLY when present, so
 *    the result is independent of the maps' field-insertion / store-
 *    serialization order. `_bidx` is always the LAST segment, so a legacy
 *    `_vdig`-only / `_bidx`-absent envelope hashes byte-identically to its
 *    stage-2 value.
 *
 * Deliberately reimplements the two-key-object canonicalization inline
 * rather than importing `with-commit/history/ledger/entry.ts`'s general
 * `canonicalJson` — `capsule/enclave-aes/**` may import only spine types (C3),
 * never a `with-*` service. For this fixed `{ _data: string; _sealed:
 * Record<string, string> }` shape the two produce byte-identical output
 * (verified against that exact call site's oracle expression in
 * `envelope-body.test.ts`).
 */
export function envelopeBodyForHash(env: EncryptedEnvelope): string {
  // Conditional widen (stage 2): bind `_vdig` exactly the way `_sealed` is
  // bound — only when present. No existing envelope carries `_vdig`, so this
  // ships with no flag-day PROVIDED it lands in the same slice as the first
  // `_vdig` writer (it does — Tasks 7/8/11 are one branch). This binding is
  // the temporal-rollback detector completing C1: AAD stops cross-record/
  // cross-field splices; the ledger hash catches same-slot rollbacks.
  //
  // Conditional widen (slice 2b, SM #5): bind `_bidx` the same way, appended
  // LAST (after `_vdig`) so a `_bidx`-absent envelope keeps its stage-2
  // byte-identical hash.
  // `?? ''` (#15): an omitted `_data` must hash identically to an emptied
  // one, or a capsule changing spelling would invalidate every ledger entry
  // written before it.
  const data = env._data ?? ''
  if (env._sealed === undefined && env._vdig === undefined && env._bidx === undefined) return data
  const mapPart = (key: '_sealed' | '_vdig' | '_bidx', map: Record<string, string>): string => {
    const parts = Object.keys(map).sort().map(
      (k) => `${JSON.stringify(k)}:${JSON.stringify(map[k])}`,
    )
    return `${JSON.stringify(key)}:{${parts.join(',')}}`
  }
  const segments = [`"_data":${JSON.stringify(data)}`]
  if (env._sealed !== undefined) segments.push(mapPart('_sealed', env._sealed))
  if (env._vdig !== undefined) segments.push(mapPart('_vdig', env._vdig))
  if (env._bidx !== undefined) segments.push(mapPart('_bidx', env._bidx))
  return `{${segments.join(',')}}`
}

/**
 * Does `env` carry an AEAD-sealed body at all?
 *
 * The one question callers outside the enclave legitimately need to ask about
 * `_iv` — a tombstone and a plaintext-collection record have none, so there is
 * nothing to authenticate and nothing to re-seal. Both {@link
 * verifyRecordIdentity} (which treats them as vacuously authentic) and the
 * merge authority's `advance` (which stamps them without re-sealing) turn on
 * it, and asking it here keeps `_iv` from leaking back out to the callers —
 * which `enclave-body-only` refused, correctly, when `advance` tested it inline.
 */
export function hasSealedBody(env: Pick<EncryptedEnvelope, '_iv'>): boolean {
  // ⛔ `env._iv !== ''` alone answered TRUE for an omitted `_iv` (#15) — the
  // exact inversion of what the caller is asking. Absence and `''` are the
  // same statement: there is nothing here to authenticate.
  return env._iv !== undefined && env._iv !== ''
}

/**
 * The cipher-dependent half: the three doors that actually reach the capsule's
 * `encrypt`/`decrypt`. Everything above this line is cipher-FREE — it inspects
 * envelope fields or derives hash input, so it stays a plain module export that
 * both capsules share with nothing to bind.
 */
export function makeEnvelopeBody(p: CapsulePrimitives) {
  const { encrypt, decrypt, generateDEK, wrapCek, unwrapCek } = p

  /**
   * Open an envelope's protected body to its JSON text.
   *
   * Mirrors the dominant direct-decrypt call-site shape (e.g.
   * `with-audit/consent/consent.ts`'s `decryptEntry`):
   *  - `opts.encrypted === false` (default `true`) → plaintext collection;
   *    returns `env._data` as-is, `key` untouched.
   *  - `env._cek` present → per-record-key envelope (mirrors
   *    `record-codec.ts`'s `resolveEnvelopeCek`): unwrap the CEK under `key`
   *    (the collection DEK), decrypt the body under the unwrapped CEK.
   *  - `env._cek` absent → legacy path, decrypt the body directly under `key`.
   */
  async function openEnvelopeJson(
    ref: RecordRef,
    env: EncryptedEnvelope,
    key: CapsuleKey,
    opts?: { encrypted?: boolean },
  ): Promise<string> {
    // A plaintext collection has no AEAD, so there is nothing to authenticate —
    // `_data` is returned as-is and identity binding does not apply to it.
    // Absent `_data` reads as `''` here, exactly as an emptied one always has:
    // a plaintext collection with nothing in it is not an error.
    if (opts?.encrypted === false) return env._data ?? ''
    // Recomputed from the ADDRESS this was fetched from plus `_tier`/`_by` read
    // off the envelope. A store that edited either one changes this value, and
    // AES-GCM then refuses the body (#1041).
    const aad = recordAadFor(ref, env)
    const { iv, data } = requireSealedBody(env, 'openEnvelopeJson')
    if (env._cek !== undefined) {
      const cek = await unwrapCek(env._cek, key)
      return decrypt(iv, data, cek, aad)
    }
    return decrypt(iv, data, key, aad)
  }

  /**
   * Produce the protected-body fields (`_iv`/`_data`/`_cek`) for an envelope a
   * caller is assembling.
   *
   *  - `opts.encrypted === false` (default `true`) → plaintext collection;
   *    emits `{ _iv: '', _data: json }` (today's `buildPlaintextEnvelope`
   *    shape), `key` untouched.
   *  - `opts.perRecordKey === true` → mints a fresh per-record CEK, encrypts
   *    the body under it, and AES-KW-wraps the CEK under `key` (mirrors
   *    `encryptJsonString`'s `cek !== undefined` branch, except the CEK is
   *    generated here rather than supplied by the caller).
   *  - otherwise → legacy path, body encrypted directly under `key`.
   */
  async function writeEnvelopeBody(
    identity: RecordIdentity,
    json: string,
    key: CapsuleKey,
    opts?: { encrypted?: boolean; perRecordKey?: boolean },
  ): Promise<Pick<EncryptedEnvelope, '_iv' | '_data' | '_cek'>> {
    if (opts?.encrypted === false) return { _iv: '', _data: json }

    const aad = buildRecordAad(identity)

    if (opts?.perRecordKey === true) {
      const cek = await generateDEK()
      const { iv, data } = await encrypt(json, cek, aad)
      const wrapped = await wrapCek(cek, key)
      return { _iv: iv, _data: data, _cek: wrapped }
    }

    const { iv, data } = await encrypt(json, key, aad)
    return { _iv: iv, _data: data }
  }

  /**
   * Does `env` authenticate at the identity `ref` claims, under `key`? (#1042)
   *
   * The merge's fail-closed check, living here because it is envelope surgery:
   * deciding "is there a sealed body at all" reads `_iv`, which
   * `enclave-body-only` reserves to this folder. An earlier draft did that test
   * in `kernel/noydb.ts` and the guard refused it — correctly, since a caller
   * outside the enclave inspecting protected fields is how envelope knowledge
   * leaks back out.
   *
   * Returns a boolean rather than throwing: `applyRemote` must be able to reject
   * one poisoned record without halting an entire sync, and a hostile store
   * would very much like the opposite.
   *
   * **A record with no sealed body is vacuously authentic** — a tombstone carries
   * none, and a plaintext collection has no AEAD to verify. Those are pass-through
   * by construction, not by omission.
   */
  async function verifyRecordIdentity(
    ref: RecordRef,
    env: EncryptedEnvelope,
    key: CapsuleKey,
  ): Promise<boolean> {
    if (!hasSealedBody(env)) return true
    try {
      await openEnvelopeJson(ref, env, key)
      return true
    } catch {
      return false
    }
  }

  return { openEnvelopeJson, writeEnvelopeBody, verifyRecordIdentity }
}
