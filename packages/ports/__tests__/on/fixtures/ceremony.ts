/**
 * A synthetic `SlotRewrapCeremony`, and the two ways of breaking it that the
 * kit must catch (core#46).
 *
 * ⚠️ NOT a `.test.ts`, and neither are the suites beside it: they are run by a
 * CHILD vitest from `kit-contract.test.ts`, which reads their exit code as
 * evidence. The main run collects only `*.test.ts`, so a suite that is supposed
 * to FAIL cannot fail the suite that reads it.
 *
 * ## Why synthetic, rather than a real ceremony
 *
 * Both shipped implementations — `on-password` and `on-webauthn` — live in
 * `noy-db/on`, a different repo on its own version line. A kit cannot reach
 * across for its own self-test, and would not want to: the point here is
 * whether the KIT is alive, and a fixture that can be broken on purpose is
 * what shows that. The real ceremonies run this same suite from their side.
 *
 * The shape is `on-password`'s wrap-DEKs ceremony: derive a method key, encrypt
 * `{ deks: { collection: base64rawDek } }` under it, hand back the
 * `EnrollAuthenticatorOptions` hub will persist. The derivation is a constant
 * here — PBKDF2 would be slower and prove nothing extra, since the subject is
 * the ceremony CONTRACT, not the KDF.
 */
import type {
  SlotRewrapCeremony,
  SlotRewrapContext,
  KeyringAuthenticator,
  EnrollAuthenticatorOptions,
  EnclaveKey,
} from '@noy-db/hub/on'

/** `none` is the reference; the other two are the controls. */
export type Defect = 'none' | 'accepts-any-method' | 'stale-deks'

export const METHOD = 'password'
const SLOT_ID = 'password-primary'
/** Stands in for a method-derived key. Constant on purpose — see the header. */
const WRAP_KEY_RAW = new Uint8Array(32).fill(7)
const IV = new Uint8Array(12).fill(3)

const b64 = (b: ArrayBuffer | Uint8Array): string =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64')

async function wrapKey(): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.importKey('raw', WRAP_KEY_RAW, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

async function sealDeks(deks: Map<string, EnclaveKey>): Promise<string> {
  const raw: Record<string, string> = {}
  for (const [collection, key] of deks) {
    raw[collection] = b64(await globalThis.crypto.subtle.exportKey('raw', key))
  }
  const plaintext = new TextEncoder().encode(JSON.stringify({ deks: raw }))
  const sealed = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, await wrapKey(), plaintext)
  return b64(sealed)
}

/** Re-open what {@link sealDeks} produced — the kit's `unwrap`. */
export async function unwrap(options: EnrollAuthenticatorOptions): Promise<Map<string, EnclaveKey>> {
  if (!('wrapped_deks' in options)) throw new Error('not a wrap-DEKs slot')
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(options.iv, 'base64') },
    await wrapKey(),
    Buffer.from(options.wrapped_deks, 'base64'),
  )
  const { deks } = JSON.parse(new TextDecoder().decode(opened)) as { deks: Record<string, string> }
  const out = new Map<string, EnclaveKey>()
  for (const [collection, raw] of Object.entries(deks)) {
    out.set(
      collection,
      (await globalThis.crypto.subtle.importKey('raw', Buffer.from(raw, 'base64'), 'AES-GCM', true, [
        'encrypt',
        'decrypt',
      ])) as EnclaveKey,
    )
  }
  return out
}

/** A DEK set that is NOT the one in the context — the `stale-deks` payload. */
async function staleDeks(): Promise<Map<string, EnclaveKey>> {
  const make = async (): Promise<EnclaveKey> =>
    (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ])) as EnclaveKey
  return new Map([
    ['invoices', await make()],
    ['clients', await make()],
  ])
}

export function ceremony(defect: Defect = 'none'): SlotRewrapCeremony {
  return async (ctx: SlotRewrapContext): Promise<EnrollAuthenticatorOptions> => {
    // ⛔ THE DEFECT, for `accepts-any-method`: no method guard. A ceremony
    // without it will happily rewrap a webauthn slot as a password slot under
    // cover of preservation — the slot-type swap hub's own validation exists
    // to prevent, arriving from the side hub trusts.
    if (defect !== 'accepts-any-method' && ctx.oldSlot.method !== METHOD) {
      throw new Error(`this ceremony handles "${METHOD}" slots, not "${ctx.oldSlot.method}"`)
    }
    // ⛔ THE DEFECT, for `stale-deks`: wraps a DEK set that is not the one in
    // the context. Everything about the returned slot is well-formed and hub's
    // own validation passes it — the slot simply cannot open the vault after
    // the rotation, which is discovered at the next unlock.
    const deks = defect === 'stale-deks' ? await staleDeks() : ctx.newDeks
    return {
      id: ctx.oldSlot.id,
      method: ctx.oldSlot.method,
      wrapKind: 'deks',
      wrapped_deks: await sealDeks(deks),
      iv: b64(IV),
      meta: { kdf: 'synthetic-constant' },
    }
  }
}

const slot = (method: KeyringAuthenticator['method']): KeyringAuthenticator => ({
  id: SLOT_ID,
  method,
  enrolled_at: '2026-09-17T00:00:00.000Z',
  enrolled_via_tier: 1,
  meta: { kdf: 'synthetic-constant' },
  wrapKind: 'deks',
  wrapped_deks: '',
  iv: b64(IV),
})

/** A slot this ceremony accepts. */
export const oldSlot = (): KeyringAuthenticator => slot(METHOD)

/**
 * A slot it must refuse — differing in `method` and NOTHING else, which the kit
 * asserts rather than trusts. Two differences would let the wrapKind guard
 * absorb the case and the method check could be deleted unnoticed.
 */
export const wrongMethodSlot = (): KeyringAuthenticator => slot('webauthn')
