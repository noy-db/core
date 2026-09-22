/**
 * core#74 — the ADMISSION capability the vault lends the sync engine.
 *
 * `with-sync` is DEK-free (enforced by `check:architecture`), so it cannot
 * evaluate a rule about a record's content. The vault can: it holds the keys,
 * the `beforePut` gate bus (guards, periods) and the `db.onBeforeWrite` hooks
 * that already run on every LOCAL write. This interface hands that judgement
 * to the engine as a closure bound to the vault, the way `MergeAuthority`
 * hands it the cryptographic one — so an incoming record is admitted or
 * refused by the same rules its writer's device would have applied, against
 * THIS device's view of the vault at the moment it arrives.
 *
 * A refusal is never an error: the engine parks the envelope under
 * `_sync_rejected`, leaves the local copy untouched, reports it in
 * `PullResult.rejected` and emits `sync:rejected`.
 */
import type { EncryptedEnvelope } from '../../kernel/types.js'

export type AdmissionVerdict =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string }

export interface AdmissionAuthority {
  admit(collection: string, id: string, envelope: EncryptedEnvelope): Promise<AdmissionVerdict>
}
