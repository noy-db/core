/**
 * `_keyring` replication between two stores (core#75).
 *
 * A sync target was never a full replica: keyring files are written by a raw
 * store put outside the dirty log, so they never reached any target, and a
 * device that lost its local store re-opened by MINTING a new owner keyring
 * whose DEKs open nothing. Measured on core#75 for one owner (case A) and for
 * an owner plus a granted user (case A2): the moment the right
 * `_keyring/<user>` envelope is in the local store, pull, read, write and push
 * all work. So this is the one collection sync has to carry.
 *
 * DEK-free by construction: a keyring file is ciphertext to the mover — the
 * DEKs inside are AES-KW-wrapped under a KEK the store never sees, and the
 * file is authenticated by its roster tag at load. Nothing here decrypts; the
 * only field read is `roster_epoch`, which is plaintext JSON on purpose
 * (#1097: it must be comparable without a key).
 *
 * ## The one rule, both directions
 *
 * **Higher `roster_epoch` wins; the absent side receives; equal is a no-op.**
 * A file with no epoch (written before #1097) never overwrites one that has
 * an epoch, and two epoch-less files never overwrite each other — absence is
 * UNKNOWN, never zero, exactly as `assertRosterEpochCurrent` reads it.
 *
 * Why an epoch and not bytes: a device holding a STALE copy of a narrowed
 * user's file (epoch 3) must not push it over the narrowed one (epoch 4) —
 * that is the replay `roster_epoch` exists to anchor, and byte-difference
 * alone would re-introduce it from the mover's side.
 *
 * ## Deletion
 *
 * Revocation deletes the file on the revoking device and is pushed through
 * the dirty log as `('_keyring', userId, 'delete')` — the one product path
 * that reaches the engine's `remote.delete` branch. On PULL, a file the
 * remote lacks and the local holds is deleted locally only when (a) the
 * remote carries at least one keyring at all — a target that has never been
 * pushed to is not evidence of revocation — and (b) no dirty entry protects
 * it (a grant made offline, not yet pushed).
 */
import type { NoydbStore, EncryptedEnvelope } from '../kernel/types.js'
import { parseKeyringEnvelope } from '../with-party/team/keyring.js'

/** `roster_epoch` of a keyring envelope; `undefined` for a pre-#1097 file or an unparsable body. */
function keyringEpoch(envelope: EncryptedEnvelope | null | undefined): number | undefined {
  if (!envelope) return undefined
  try {
    const epoch = parseKeyringEnvelope(envelope).roster_epoch
    return typeof epoch === 'number' ? epoch : undefined
  } catch {
    return undefined
  }
}

export const KEYRING_COLLECTION = '_keyring'

/**
 * Open-path bootstrap: an EMPTY local store is not evidence of a new vault
 * when a `sync-peer` already carries the roster. Mirror its files in first;
 * `assertKeyringOpenAllowed` then decides — own file → open, other
 * principals only → refuse, still nothing → genuinely new. Backups are
 * never consulted (never pulled from, #616). No-op when the local already
 * holds any keyring.
 */
export async function bootstrapKeyrings(local: NoydbStore, peer: NoydbStore | undefined, vault: string): Promise<void> {
  if (!peer) return
  if ((await local.list(vault, KEYRING_COLLECTION)).length > 0) return
  await mirrorKeyrings(peer, local, vault)
}

/** True when `candidate` should replace `current` under the one rule above. */
function keyringSupersedes(candidate: EncryptedEnvelope, current: EncryptedEnvelope | null): boolean {
  if (!current) return true
  const c = keyringEpoch(candidate)
  const k = keyringEpoch(current)
  if (c === undefined) return false
  if (k === undefined) return true
  return c > k
}

export interface KeyringMirrorResult {
  /** Files written to `to`. */
  readonly copied: number
  /** Files deleted from `to` (pull-side revocation propagation only). */
  readonly deleted: number
}

/**
 * Copy every `_keyring` file that supersedes its counterpart from `from` to
 * `to`. Never deletes. This is the push half, and the bootstrap an empty
 * local runs on open. `fromUsers` lets a caller that already listed `from`
 * avoid a second round-trip.
 */
export async function mirrorKeyrings(
  from: NoydbStore,
  to: NoydbStore,
  vault: string,
  fromUsers?: readonly string[],
): Promise<KeyringMirrorResult> {
  let copied = 0
  for (const userId of fromUsers ?? await from.list(vault, KEYRING_COLLECTION)) {
    const candidate = await from.get(vault, KEYRING_COLLECTION, userId)
    if (!candidate) continue
    const current = await to.get(vault, KEYRING_COLLECTION, userId)
    if (!keyringSupersedes(candidate, current)) continue
    await to.put(vault, KEYRING_COLLECTION, userId, candidate)
    copied++
  }
  return { copied, deleted: 0 }
}

/**
 * The pull half: {@link mirrorKeyrings} from `remote` into `local`, then
 * propagate revocations — delete a local file the remote lacks, subject to
 * the two guards in the module doc. `protectedUsers` is the set of user ids
 * with a pending local dirty entry (a grant not yet pushed).
 *
 * Costs ONE remote round-trip (`list('_keyring')`) per pull, and none at all
 * for a vault with no local keyring files: an encrypted vault always holds
 * the caller's own file after open (bootstrapped or minted), so "no local
 * keyring" means `encrypt: false` — nothing to mirror, nothing to ask.
 */
export async function pullKeyrings(
  remote: NoydbStore,
  local: NoydbStore,
  vault: string,
  protectedUsers: ReadonlySet<string>,
): Promise<KeyringMirrorResult> {
  const localUsers = await local.list(vault, KEYRING_COLLECTION)
  if (localUsers.length === 0) return { copied: 0, deleted: 0 }
  const remoteUsers = await remote.list(vault, KEYRING_COLLECTION)
  const { copied } = await mirrorKeyrings(remote, local, vault, remoteUsers)
  let deleted = 0
  if (remoteUsers.length > 0) {
    const remoteSet = new Set(remoteUsers)
    for (const userId of localUsers) {
      if (remoteSet.has(userId) || protectedUsers.has(userId)) continue
      await local.delete(vault, KEYRING_COLLECTION, userId)
      deleted++
    }
  }
  return { copied, deleted }
}
