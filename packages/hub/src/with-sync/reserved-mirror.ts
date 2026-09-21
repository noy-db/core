/**
 * Reserved-record replication between two stores (core#75, core#83, core#82).
 *
 * `loadAll()` skips every `_`-prefixed collection, so nothing reserved
 * travels through a sync target unless it is named here. `_keyring` was the
 * first (core#75): a target was never a full replica — a device that lost
 * its local store re-opened by MINTING a new owner keyring whose DEKs open
 * nothing, and a granted member could not open on their own device at all.
 * The invite audit doc was the second (core#83): `acceptInvite` refuses
 * without it, by design, so magic-link onboarding onto a fresh sync-peer
 * device was closed.
 *
 * ## Declared, never blanket
 *
 * `_meta` mixes VAULT state (deed, adoption, recovery docs, invite audit
 * docs) with DEVICE/SESSION state (`schema-fence`, the pod `handle`) that
 * must never reach another device — a replicated fence would break every
 * other device's cutover. So replication is a declared set of
 * `(collection, id prefix)` rules, each with its own ordering, and a
 * reserved record travels only when a rule names it. The decision per
 * collection, written down (core#82):
 *
 * | collection | rule | why |
 * |---|---|---|
 * | `_keyring` | higher `roster_epoch` wins | the roster; replay-anchored by #1097 |
 * | `_meta/invite-audit-*` | higher `_v` wins | single-use evidence for magic links (core#83) |
 * | `_users` | higher `_v` wins | the directory's user envelopes; a member app renders these |
 * | `_delegations` | higher `_v` wins | delegation tokens; revocation is a delete |
 * | `_history`, `_ledger` | NOT replicated | per-device evidence: the ledger is a hash chain per writer, two devices appending would fork it; `vault.at(T)` runs where history lives |
 * | `_sync` | NOT replicated | this device's dirty log and watermarks |
 * | `_meta/schema-fence`, `_meta/handle`, other `_meta` | NOT replicated | session and instance state; the rest of `_meta` is decided one id at a time |
 *
 * DEK-free by construction: every rule compares a field the mover can read
 * without a key — `roster_epoch` (plaintext JSON on purpose, #1097, read
 * through `team/keyring.ts`'s parser) or the envelope's `_v`.
 *
 * ## The one rule, both directions
 *
 * **The candidate wins when it supersedes; the absent side receives; equal
 * is a no-op.** For `_keyring`, a file with no epoch (pre-#1097) never
 * overwrites one that has an epoch. Why an ordering and not bytes: a device
 * holding a STALE copy (epoch 3, or `_v` 1) must not push it over the newer
 * one (epoch 4, `_v` 2) — byte-difference alone would re-introduce exactly
 * the replay the ordering exists to anchor.
 *
 * ## Deletion
 *
 * A revocation (keyring, delegation, user envelope) deletes the record on
 * the acting device and is pushed through the dirty log as
 * `(collection, id, 'delete')`. On PULL, a record the remote lacks and the
 * local holds is deleted locally only when (a) the remote carries at least
 * one record of that collection — a target never pushed to is not evidence
 * of revocation — and (b) no dirty entry protects it (a grant made offline,
 * not yet pushed). Invite audit docs are never deleted; revocation is a
 * field update, which the `_v` rule carries.
 */
import type { NoydbStore, EncryptedEnvelope } from '../kernel/types.js'
import { parseKeyringEnvelope } from '../with-party/team/keyring.js'

const KEYRING_COLLECTION = '_keyring'

interface ReservedReplicationRule {
  readonly collection: string
  /** Only ids starting with this prefix are in scope; absent ⇒ the whole collection. */
  readonly idPrefix?: string
  /** True when `candidate` should replace `current`. */
  readonly supersedes: (candidate: EncryptedEnvelope, current: EncryptedEnvelope | null) => boolean
  /** Whether a record the remote lacks is deleted locally on pull (subject to the two guards). */
  readonly propagateDeletes: boolean
}

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

function keyringSupersedes(candidate: EncryptedEnvelope, current: EncryptedEnvelope | null): boolean {
  if (!current) return true
  const c = keyringEpoch(candidate)
  const k = keyringEpoch(current)
  if (c === undefined) return false
  if (k === undefined) return true
  return c > k
}

function versionSupersedes(candidate: EncryptedEnvelope, current: EncryptedEnvelope | null): boolean {
  if (!current) return true
  return candidate._v > current._v
}

/** The declared set. Order matters: the roster travels FIRST, before anything it gates. */
const RESERVED_REPLICATION: readonly ReservedReplicationRule[] = [
  { collection: KEYRING_COLLECTION, supersedes: keyringSupersedes, propagateDeletes: true },
  { collection: '_meta', idPrefix: 'invite-audit-', supersedes: versionSupersedes, propagateDeletes: false },
  { collection: '_users', supersedes: versionSupersedes, propagateDeletes: true },
  { collection: '_delegations', supersedes: versionSupersedes, propagateDeletes: true },
]

export interface ReservedMirrorResult {
  /** Records written to `to`. */
  readonly copied: number
  /** Records deleted from `to` (pull-side revocation propagation only). */
  readonly deleted: number
  /** Ids of `_keyring` files copied — the roster reload seam reads this for the caller's own file. */
  readonly keyringsCopied: readonly string[]
}

function inScope(rule: ReservedReplicationRule, id: string): boolean {
  return rule.idPrefix === undefined || id.startsWith(rule.idPrefix)
}

/**
 * Copy every in-scope record that supersedes its counterpart from `from`
 * to `to`, for one rule. Never deletes. `fromIds` lets a caller that already
 * listed `from` avoid a second round-trip.
 */
async function mirrorRule(
  rule: ReservedReplicationRule,
  from: NoydbStore,
  to: NoydbStore,
  vault: string,
  fromIds?: readonly string[],
): Promise<string[]> {
  const copied: string[] = []
  for (const id of fromIds ?? await from.list(vault, rule.collection)) {
    if (!inScope(rule, id)) continue
    const candidate = await from.get(vault, rule.collection, id)
    if (!candidate) continue
    const current = await to.get(vault, rule.collection, id)
    if (!rule.supersedes(candidate, current)) continue
    await to.put(vault, rule.collection, id, candidate)
    copied.push(id)
  }
  return copied
}

/** The push half: mirror every declared rule from `local` to `remote`. Never deletes. */
export async function pushReserved(local: NoydbStore, remote: NoydbStore, vault: string): Promise<ReservedMirrorResult> {
  let copied = 0
  let keyringsCopied: readonly string[] = []
  for (const rule of RESERVED_REPLICATION) {
    const ids = await mirrorRule(rule, local, remote, vault)
    copied += ids.length
    if (rule.collection === KEYRING_COLLECTION) keyringsCopied = ids
  }
  return { copied, deleted: 0, keyringsCopied }
}

/**
 * The pull half: mirror every declared rule from `remote` into `local`, then
 * propagate revocations under the two guards in the module doc.
 * `protectedIds` maps a collection to the ids a pending local dirty entry
 * protects.
 *
 * Costs one `list()` per rule per pull, and nothing at all for a vault with
 * no local keyring: an encrypted vault always holds the caller's own file
 * after open (bootstrapped or minted), so "no local keyring" means
 * `encrypt: false` — nothing reserved to mirror, nothing to ask.
 */
export async function pullReserved(
  remote: NoydbStore,
  local: NoydbStore,
  vault: string,
  protectedIds: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ReservedMirrorResult> {
  const localKeyrings = await local.list(vault, KEYRING_COLLECTION)
  if (localKeyrings.length === 0) return { copied: 0, deleted: 0, keyringsCopied: [] }
  let copied = 0
  let deleted = 0
  let keyringsCopied: readonly string[] = []
  for (const rule of RESERVED_REPLICATION) {
    const remoteIds = (await remote.list(vault, rule.collection)).filter(id => inScope(rule, id))
    const ids = await mirrorRule(rule, remote, local, vault, remoteIds)
    copied += ids.length
    if (rule.collection === KEYRING_COLLECTION) keyringsCopied = ids
    if (!rule.propagateDeletes || remoteIds.length === 0) continue
    const remoteSet = new Set(remoteIds)
    const protectedSet = protectedIds.get(rule.collection)
    const localIds = rule.collection === KEYRING_COLLECTION ? localKeyrings : await local.list(vault, rule.collection)
    for (const id of localIds) {
      if (!inScope(rule, id) || remoteSet.has(id) || protectedSet?.has(id)) continue
      await local.delete(vault, rule.collection, id)
      deleted++
    }
  }
  return { copied, deleted, keyringsCopied }
}

/**
 * Open-path bootstrap: an EMPTY local store is not evidence of a new vault
 * when a `sync-peer` already carries the roster. Mirror its keyring files in
 * first; `assertKeyringOpenAllowed` then decides — own file → open, other
 * principals only → refuse, still nothing → genuinely new. Backups are
 * never consulted (never pulled from, #616). No-op when the local already
 * holds any keyring. Only the roster: the rest of the declared set arrives
 * on the first `pull()`.
 */
export async function bootstrapKeyrings(local: NoydbStore, peer: NoydbStore | undefined, vault: string): Promise<void> {
  if (!peer) return
  if ((await local.list(vault, KEYRING_COLLECTION)).length > 0) return
  await mirrorRule(RESERVED_REPLICATION[0]!, peer, local, vault)
}
