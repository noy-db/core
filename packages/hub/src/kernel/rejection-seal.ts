/**
 * core#107 — sealing and opening a replicated admission refusal.
 *
 * Lives outside `vault.ts` for the reason the kernel-surface ceiling exists:
 * the vault owns the KEY LOOKUP and stays a thin caller, the crypto lives
 * here. Shape follows `team/delegation.ts`'s token seal exactly — an AAD-bound
 * record envelope under a DEK the recipient already holds.
 *
 * The DEK is the refused record's OWN collection DEK; `port/with/rejection-courier.ts`
 * carries why, and why core#107's proposed `_sync` DEK does not exist.
 */
import { buildRecordAad, buildRecordEnvelope, encrypt, openEnvelopeJson } from '../capsule/index.js'
import type { EnclaveKey } from '../capsule/index.js'
import type { EncryptedEnvelope, SyncRejection } from './types.js'

/** core#107 — where replicated refusals live. Reserved, declared in `reserved-mirror.ts`. */
export const REJECTIONS_COLLECTION = '_sync_rejections'

/** `<collection>::<id>` — one live refusal per record, newer `_v` supersedes. */
export const rejectionKey = (collection: string, id: string): string => `${collection}::${id}`

export async function sealRejection(
  collection: string,
  id: string,
  rejection: SyncRejection,
  dek: EnclaveKey,
  version: number,
): Promise<EncryptedEnvelope> {
  const key = rejectionKey(collection, id)
  const identity = { collection: REJECTIONS_COLLECTION, id: key, by: rejection.by, version }
  const { iv, data } = await encrypt(JSON.stringify(rejection), dek, buildRecordAad(identity))
  return buildRecordEnvelope(identity, { ts: rejection.at, iv, data })
}

/**
 * `null` when this device cannot open it. Never throws: a member who does not
 * hold the collection's DEK receives the envelope like everybody else (the
 * mirror is DEK-free and copies it unconditionally) and must skip it quietly.
 */
export async function openRejection(
  collection: string,
  id: string,
  envelope: EncryptedEnvelope,
  dek: EnclaveKey,
): Promise<SyncRejection | null> {
  try {
    // `openEnvelopeJson` returns the decrypted STRING; the parse is ours.
    const plaintext = await openEnvelopeJson(
      { collection: REJECTIONS_COLLECTION, id: rejectionKey(collection, id) }, envelope, dek,
    )
    return JSON.parse(plaintext) as SyncRejection
  } catch {
    return null
  }
}
