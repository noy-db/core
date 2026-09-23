/**
 * Time-boxed cross-tier delegation tokens.
 *
 * A higher-tier user can issue a delegation that grants another user
 * temporary access to records at a specified tier. The delegation is
 * persisted as an encrypted envelope in the reserved `_delegations`
 * collection. The target user's runtime scans this collection on every
 * open and, while `until` is still in the future, merges the
 * unwrapped tier DEKs into their in-memory DEK map.
 *
 * ## Token shape
 *
 * ```
 * {
 *   id,             // ULID, also the _delegations record id
 *   toUser,         // grantee user id
 *   fromUser,       // grantor user id (owner/admin/higher-tier principal)
 *   tier,           // tier being delegated
 *   collection,     // collection name OR null for "every collection"
 *   record,         // optional specific record id
 *   until,          // ISO timestamp — token expires at this instant
 *   wrappedDek,     // base64 AES-KW-wrapped tier DEK, under the token's content key
 *   sealedCek,      // that content key, RSA-OAEP-sealed to the target's inbox public half
 *   createdAt,      // ISO timestamp
 * }
 * ```
 *
 * ## Cross-user (core#65)
 *
 * The wrap key is a per-token CONTENT KEY, not anybody's KEK: the tier DEKs are
 * AES-KW-wrapped under it exactly as they used to be under a KEK, and the key
 * itself is RSA-OAEP-sealed to the target's INBOX PUBLIC HALF (core#96 mints
 * that pair for every grantee, private half sealed under a DEK only that
 * member's own KEK unwraps). So a grantor delegates to somebody whose secret it
 * does not know — the thing this module could not do — while the slot NAMES
 * stay readable to any member holding the `_delegations` DEK, which is what
 * makes an audit enumeration possible without making the keys usable.
 *
 * The ciphertext is stored as a normal noy-db envelope — the
 * `_delegations` collection has its own DEK shared across all vault
 * users, so an operator can enumerate active delegations for audit
 * without being able to *use* them (the `wrappedDek` inside is still
 * keyed to the target user's KEK).
 *
 * ## Revocation
 *
 * Delete the `_delegations/<id>` envelope. The target user's runtime
 * reloads the delegation list at each open and at periodic intervals
 * (tracked by the caller — this module is pure logic).
 *
 * @module
 */

import type { NoydbStore, KeyringFile } from '../../kernel/types.js'
import type { UnlockedKeyring } from './keyring.js'
import {
  buildRecordAad, buildRecordEnvelope, encrypt, openEnvelopeJson, wrapKey, unwrapKey,
  importWrappingKey, importRecipientPublicKeySpki, recipientWrap, recipientUnwrap,
  bufferToBase64, base64ToBuffer, type EnclaveKey,
} from '../../capsule/index.js'
import { dekKey } from './tiers.js'
import { readKeyringFile, openInboxKeyPair } from './keyring.js'
import { INBOX_KEY_ID } from '../../kernel/constants.js'
import { DelegationTargetMissingError, MemberInboxMissingError } from '../../kernel/errors.js'
import { generateULID } from '../../with-pod/ulid.js'

export const DELEGATIONS_COLLECTION = '_delegations'

/**
 * Durable payload of a delegation token. Encrypted under the vault's
 * `_delegations` DEK; the `wrappedDek` inside is additionally wrapped
 * under the target user's KEK.
 */
export interface DelegationToken {
  readonly id: string
  readonly toUser: string
  readonly fromUser: string
  readonly tier: number
  /**
   * Collection name, or `null` for a COLLECTION-WIDE token — see
   * {@link DelegationToken.wrappedDeks} for what that means and what it cannot
   * mean.
   */
  readonly collection: string | null
  /** Optional specific record id scope. */
  readonly record?: string
  readonly until: string
  /**
   * The delegated tier DEK for {@link DelegationToken.collection}, wrapped
   * under the target's KEK. Present on a per-collection token; absent on a
   * collection-wide one, which carries {@link DelegationToken.wrappedDeks}.
   */
  readonly wrappedDek?: string
  /**
   * A collection-wide token's payload: `<collection>#<tier>` → wrapped DEK, one
   * entry per collection the grantor held at that tier (core#56).
   *
   * ## ⛔ Why a MAP and not one key
   *
   * Every collection has its OWN tier DEK — measured, `docs#1` and `ledger#1`
   * are different keys. The original design tried to express "every collection"
   * as a single DEK under a wildcard slot `__any#<tier>`, which cannot work: one
   * key decrypts one collection. A wildcard accepted at the access gate would
   * have passed the check and then failed decryption — a gate that says yes
   * followed by a crypto error. `__any#` is gone; every entry here merges under
   * its REAL `<collection>#<tier>` key, so `assertTierAccess` needs no wildcard
   * and gains no new privilege surface.
   *
   * ## ⚠️ "Every collection" means "every collection AS OF ISSUE TIME"
   *
   * This is a SNAPSHOT. A collection created after the token was issued is not
   * in it and will not be granted by it — the grantor did not hold its DEK to
   * wrap. That is a real limit of the shape, not an oversight, and it is stated
   * here because a caller who reads "all collections" will otherwise assume
   * otherwise.
   */
  readonly wrappedDeks?: Readonly<Record<string, string>>
  /**
   * core#65 — the token's CONTENT KEY, RSA-OAEP-sealed to the target's inbox
   * public half. `wrappedDek` / `wrappedDeks` are AES-KW-wrapped under it, so
   * only the target can unwrap them, and only they can: the matching private
   * half is sealed in their keyring under a DEK their own KEK unwraps.
   *
   * Absent on a token written before core#65, whose wraps are under the
   * grantor's own KEK — those still load for a target that shares that KEK
   * (the only case that ever worked) and are skipped for anyone else, exactly
   * as before.
   */
  readonly sealedCek?: string
  readonly createdAt: string
}

export interface IssueDelegationOptions {
  readonly toUser: string
  readonly tier: number
  readonly collection?: string
  readonly record?: string
  readonly until: Date | string
}

/**
 * Build and persist a delegation token. The caller must hold a tier-N DEK; the
 * target must have a keyring in this vault with an inbox key pair (core#96).
 *
 * core#65 — the wraps are keyed to a per-token content key sealed to that
 * pair, so the grantor needs nothing of the target's but their PUBLIC half.
 */
export async function issueDelegation(
  store: NoydbStore,
  vault: string,
  grantor: UnlockedKeyring,
  delegationsDek: EnclaveKey,
  opts: IssueDelegationOptions,
): Promise<DelegationToken> {
  const targetFound = await readKeyringFile(store, vault, opts.toUser)
  if (!targetFound) {
    throw new DelegationTargetMissingError(opts.toUser)
  }
  const targetInbox = targetFound.file.inbox_key
  if (!targetInbox) {
    throw new MemberInboxMissingError(
      opts.toUser,
      `Delegation target "${opts.toUser}" has a keyring with no inbox key pair — it predates core#96, ` +
      'so a delegated key cannot be sealed to them. Re-grant the user once (a fresh temporary secret ' +
      'they rotate on first open); the new keyring carries the pair.',
    )
  }
  const cekBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const targetKek = await importWrappingKey(cekBytes)
  const sealedCek = bufferToBase64(await recipientWrap(await importRecipientPublicKeySpki(base64ToBuffer(targetInbox.pub)), cekBytes))
  cekBytes.fill(0)
  const tier = opts.tier
  const collectionName = opts.collection ?? null

  // Collection-wide: wrap EVERY tier DEK the grantor holds at this tier, each
  // under its own real slot key. See `wrappedDeks` for why this is a map and
  // for the as-of-issue-time limit it carries.
  let wrappedDek: string | undefined
  let wrappedDeks: Record<string, string> | undefined
  if (collectionName === null) {
    const suffix = `#${tier}`
    const entries: Record<string, string> = {}
    for (const [slot, dek] of grantor.deks) {
      if (slot.endsWith(suffix)) entries[slot] = await wrapKey(dek, targetKek)
    }
    if (Object.keys(entries).length === 0) {
      throw new DelegationTargetMissingError(
        opts.toUser,
        `grantor holds no tier-${tier} DEK for ANY collection, so a collection-wide ` +
        `delegation would grant nothing. Obtain a tier grant first, or name a ` +
        `\`collection\`.`,
      )
    }
    wrappedDeks = entries
  } else {
    const sourceDek = grantor.deks.get(dekKey(collectionName, tier))
    if (!sourceDek) {
      throw new DelegationTargetMissingError(
        opts.toUser,
        `grantor holds no tier-${tier} DEK for collection "${collectionName}", so there ` +
        `is nothing to delegate. Obtain the tier grant first.`,
      )
    }
    wrappedDek = await wrapKey(sourceDek, targetKek)
  }

  const until = typeof opts.until === 'string' ? opts.until : opts.until.toISOString()
  const token: DelegationToken = {
    id: generateULID(),
    toUser: opts.toUser,
    fromUser: grantor.userId,
    tier,
    collection: collectionName,
    ...(opts.record && { record: opts.record }),
    until,
    ...(wrappedDek !== undefined && { wrappedDek }),
    ...(wrappedDeks !== undefined && { wrappedDeks }),
    sealedCek,
    createdAt: new Date().toISOString(),
  }

  const plaintext = JSON.stringify(token)
  const identity = { collection: DELEGATIONS_COLLECTION, id: token.id, by: grantor.userId, version: 1 }
  const { iv, data } = await encrypt(plaintext, delegationsDek, buildRecordAad(identity))
  const envelope = buildRecordEnvelope(
    identity,
    { ts: token.createdAt, iv, data},
  )
  await store.put(vault, DELEGATIONS_COLLECTION, token.id, envelope)
  return token
}

/**
 * ## Why the vault calls this EXPLICITLY, and never from `openVault` (core#56)
 *
 * The module header above describes a runtime that scans on every open. Doing
 * that automatically would call `getDEK('_delegations')`, which MINTS a DEK when
 * absent and persists the keyring — so merely opening a vault would write to it.
 * Worse, on a vault whose shared `_delegations` DEK this user does not hold, it
 * would mint a WRONG one and then fail to decrypt every token under it.
 *
 * ⛔ A read path must not have that side effect. `Vault.refreshDelegations()`
 * therefore lists first, returns `[]` when nothing is written, and looks the DEK
 * up WITHOUT minting — which also makes the module header's "at each open"
 * cheap to honour, and its "periodic intervals (tracked by the caller)" is what
 * an explicit method is.
 *
 * ## Cross-user delegation (core#65) — and the one thing it still needs
 *
 * A token's wraps are keyed to a per-token content key sealed to the target's
 * INBOX PUBLIC HALF, so any member can be a target. Opening one therefore needs
 * that member's inbox PRIVATE half, which is sealed in their keyring file under
 * `deks[INBOX_KEY_ID]` — so this function reads the caller's own keyring file,
 * once, and only when a sealed token is actually addressed to them.
 *
 * ⚠️ A pre-core#65 token (no `sealedCek`) is wrapped under the GRANTOR's KEK and
 * still requires `user.kek`; it is skipped for anyone who does not share it,
 * which is the behaviour those tokens were written under.
 */

/**
 * Enumerate every live (non-expired) delegation addressed to `toUser`
 * and merge the unwrapped tier DEKs into their keyring. Returns the
 * list of merged delegations so the caller can register per-access
 * audit context.
 */
export async function loadActiveDelegations(
  store: NoydbStore,
  vault: string,
  user: UnlockedKeyring,
  delegationsDek: EnclaveKey,
  now: Date = new Date(),
): Promise<DelegationToken[]> {
  const ids = await store.list(vault, DELEGATIONS_COLLECTION)
  const merged: DelegationToken[] = []
  const nowIso = now.toISOString()
  /** This member's own inbox key pair material, read at most once per call. `null` = read, absent. */
  let ownInbox: NonNullable<KeyringFile['inbox_key']> | null | undefined
  for (const id of ids) {
    const env = await store.get(vault, DELEGATIONS_COLLECTION, id)
    if (!env) continue
    let token: DelegationToken
    try {
      const plaintext = await openEnvelopeJson({ collection: DELEGATIONS_COLLECTION, id }, env, delegationsDek)
      token = JSON.parse(plaintext) as DelegationToken
    } catch {
      continue
    }
    if (token.toUser !== user.userId) continue
    if (token.until <= nowIso) continue

    // core#65 — the wrap key. A sealed token carries its own content key,
    // opened with this member's inbox pair; a legacy token is under the
    // grantor's KEK and needs `user.kek`, absent on a tier-3 PIN resume, a
    // wrap-DEKs tier-2 unlock or a session restore (reached again at the next
    // tier-1 unlock). A sealed token has no such limit: the pair's private
    // half is sealed under a DEK the rebuilt set already carries.
    let wrapKeyForToken: EnclaveKey
    if (token.sealedCek !== undefined) {
      const inboxKeyAes = user.deks.get(INBOX_KEY_ID)
      if (!inboxKeyAes) continue
      if (ownInbox === undefined) {
        const own = await readKeyringFile(store, vault, user.userId)
        ownInbox = own?.file.inbox_key ?? null
      }
      if (!ownInbox) continue
      try {
        const pair = await openInboxKeyPair(ownInbox, inboxKeyAes)
        const cekBytes = await recipientUnwrap(pair, base64ToBuffer(token.sealedCek))
        try {
          wrapKeyForToken = await importWrappingKey(cekBytes)
        } finally {
          cekBytes.fill(0)
        }
      } catch {
        // Sealed to somebody else's pair, or this member's own pair was
        // replaced (a re-grant mints a fresh one). Not ours to open.
        continue
      }
    } else {
      if (!user.kek) continue
      wrapKeyForToken = user.kek
    }

    // ⭐ Every merged key lands under its REAL `<collection>#<tier>` slot, which
    // is exactly what `assertTierAccess` and `getDEK` already look up. There is
    // no wildcard slot and no lookup change anywhere — see `wrappedDeks`.
    const wraps: Record<string, string> = token.collection
      ? (token.wrappedDek ? { [dekKey(token.collection, token.tier)]: token.wrappedDek } : {})
      : { ...(token.wrappedDeks ?? {}) }
    if (Object.keys(wraps).length === 0) continue

    let anyMerged = false
    for (const [slot, wrapped] of Object.entries(wraps)) {
      let dek: EnclaveKey
      try {
        dek = await unwrapKey(wrapped, wrapKeyForToken)
      } catch {
        // One unusable entry must not discard the rest of a collection-wide
        // token — a revoked or re-wrapped collection is the expected case.
        continue
      }
      user.deks.set(slot, dek)
      anyMerged = true
    }
    if (!anyMerged) continue
    merged.push(token)
  }
  return merged
}

/**
 * Revoke a delegation by id — the caller resolves the envelope and
 * issues a `delete`. Provided as a stable helper so the naming is
 * symmetric to `issueDelegation`.
 */
export async function revokeDelegation(
  store: NoydbStore,
  vault: string,
  id: string,
): Promise<void> {
  await store.delete(vault, DELEGATIONS_COLLECTION, id)
}
