/**
 * core#107 — the SEALING capability the vault lends the sync engine for
 * replicated admission refusals.
 *
 * `with-sync` is DEK-free (enforced by `check:architecture`), so it can move a
 * sealed rejection but cannot make or read one. The vault can. Same shape as
 * `AdmissionAuthority`: a closure bound to the vault, handed to the engine at
 * open.
 *
 * ## Which key, and why not the one core#107 proposed
 *
 * The issue proposed "the `_sync` DEK every member holds". There is no such
 * DEK: `_sync` is this DEVICE's dirty log and watermarks, and
 * `reserved-mirror.ts` declares it NOT replicated. Minting a new shared slot
 * would put a DEK in every keyring — and strand every member granted before
 * the change, exactly as a pre-core#96 keyring is stranded without an inbox
 * pair.
 *
 * So a rejection is sealed under the REFUSED RECORD'S OWN collection DEK.
 * Nothing new enters a keyring, and the confidentiality falls out right rather
 * than being argued for: `reason` is a consumer's rule message and can quote
 * the record ("PERIOD_CLOSED: invoice 4472 is in a closed period"), so the
 * people who may read it are exactly the people who could read the record.
 * A member without the collection sees ciphertext they cannot open and skips
 * it, which is also why `open()` returns `null` rather than throwing.
 */
import type { EncryptedEnvelope, SyncRejection } from '../../kernel/types.js'

export interface RejectionCourier {
  /**
   * Seal a refusal for replication. `null` when this device holds no DEK for
   * `collection` — an arbiter that cannot read the collection it refused for
   * says nothing rather than emitting a rejection nobody can open.
   */
  seal(collection: string, id: string, rejection: SyncRejection, version: number): Promise<EncryptedEnvelope | null>
  /** Open a replicated refusal. `null` when this device cannot (no DEK, or not for it). */
  open(collection: string, id: string, envelope: EncryptedEnvelope): Promise<SyncRejection | null>
}
