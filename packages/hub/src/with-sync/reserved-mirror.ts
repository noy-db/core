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
 * | `_broker`, `_broker_member` | higher `_v` wins | broker seeds (core#91) — sealed under DEKs only their holder has; a fresh device mints from them |
 * | `_history`, `_ledger` | NOT replicated | per-device evidence: the ledger is a hash chain per writer, two devices appending would fork it; `vault.at(T)` runs where history lives |
 * | `_sync_rejections` | higher `_v` wins | core#107 — the arbiter's refusals, sealed under the refused record's own collection DEK |
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
 * one KEYRING file — a target never pushed to is not evidence of revocation,
 * but a collection that emptied by revocation is exactly what must propagate
 * (core#91) — and (b) no dirty entry protects it (a grant made offline, not
 * yet pushed). Invite audit docs are never deleted; revocation is a
 * field update, which the `_v` rule carries.
 */
import type { NoydbStore, EncryptedEnvelope } from '../kernel/types.js'
import { parseKeyringEnvelope } from '../with-party/team/keyring.js'
import { REJECTIONS_COLLECTION } from '../kernel/rejection-seal.js'

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

/** What makes two copies of a keyring file "the same edit": epoch, the authenticated authority (its tag), and the display name. */
function keyringIdentity(envelope: EncryptedEnvelope): string {
  const file = parseKeyringEnvelope(envelope)
  return `${file.roster_epoch ?? ''}:${file.roster_tag.data}:${file.display_name}`
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
  // core#91 — the broker seeds. `_broker/<brokerId>` is sealed under the
  // admin `_broker` DEK (owner/admin only hold it), `_broker_member/<userId>`
  // under that grantee's own DEK: both are ciphertext to the mover and to every
  // other device, and both are exactly what a fresh device needs to mint its
  // first credential. Revocation is a delete that rides the dirty log.
  // core#97 — SECOND, right behind the roster: on a fresh device every target
  // request before the seed has landed cannot be served by the device's own
  // mint, so the seed travels before anything else a first pull carries.
  { collection: '_broker_member', supersedes: versionSupersedes, propagateDeletes: true },
  { collection: '_broker', supersedes: versionSupersedes, propagateDeletes: true },
  { collection: '_meta', idPrefix: 'invite-audit-', supersedes: versionSupersedes, propagateDeletes: false },
  { collection: '_users', supersedes: versionSupersedes, propagateDeletes: true },
  { collection: '_delegations', supersedes: versionSupersedes, propagateDeletes: true },
  // core#107 — the arbiter's admission refusals, so the WRITER learns its
  // offline record was rejected instead of the verdict staying on the device
  // that made it. Sealed under the refused record's OWN collection DEK, so
  // this mover still reads nothing (`_v` is on the envelope) and a member
  // without that collection receives ciphertext they quietly skip.
  // `propagateDeletes: true` — clearing a refusal is how it stops being shown.
  { collection: REJECTIONS_COLLECTION, supersedes: versionSupersedes, propagateDeletes: true },
]

export interface ReservedMirrorResult {
  /** Records written to `to`. */
  readonly copied: number
  /** Records deleted from `to` (pull-side revocation propagation only). */
  readonly deleted: number
  /** Ids of `_keyring` files copied — the roster reload seam reads this for the caller's own file. */
  readonly keyringsCopied: readonly string[]
  /**
   * core#96 (pilot-1, finding B) — push only: local `_keyring` files the epoch
   * rule did not write and whose content differs from the remote's (the remote
   * is ahead, or the two diverged at one epoch). The local edit LOST; the
   * engine reports each as a `Conflict` so an authority edit made on a stale
   * copy is never silently dropped.
   */
  readonly staleKeyrings?: readonly { readonly id: string; readonly local: EncryptedEnvelope; readonly remote: EncryptedEnvelope }[]
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
  const staleKeyrings: { id: string; local: EncryptedEnvelope; remote: EncryptedEnvelope }[] = []
  for (const rule of RESERVED_REPLICATION) {
    const ids = await mirrorRule(rule, local, remote, vault)
    copied += ids.length
    if (rule.collection === KEYRING_COLLECTION) {
      keyringsCopied = ids
      // core#96 — a local file that was NOT written above and differs from the
      // remote's copy is an edit the epoch rule discarded: the remote is ahead,
      // or the two diverged at the same epoch (an edit made on a stale copy
      // bumps to the epoch the remote already holds). Right to discard, wrong
      // to swallow — reported here, at the one site that knows.
      for (const id of await local.list(vault, KEYRING_COLLECTION)) {
        if (ids.includes(id)) continue
        const [mine, theirs] = await Promise.all([local.get(vault, KEYRING_COLLECTION, id), remote.get(vault, KEYRING_COLLECTION, id)])
        if (mine && theirs && keyringIdentity(mine) !== keyringIdentity(theirs)) staleKeyrings.push({ id, local: mine, remote: theirs })
      }
    }
  }
  return { copied, deleted: 0, keyringsCopied, ...(staleKeyrings.length > 0 && { staleKeyrings }) }
}

/**
 * core#96 (pilot-1, finding B) — bring ONE member's keyring file down from the
 * target if the target's copy supersedes the local one. The kernel calls it
 * before every authority edit (`grant` on an existing user, `updateUser`,
 * `revoke`, `recoverUser`), so the edit is made on the current file and its
 * push wins instead of being discarded by the epoch rule. One GET.
 */
export async function pullKeyringFile(remote: NoydbStore, local: NoydbStore, vault: string, userId: string): Promise<boolean> {
  const rule = RESERVED_REPLICATION[0]!
  const ids = await mirrorRule(rule, remote, local, vault, [userId])
  return ids.length > 0
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
  // "Has this target ever been pushed to?" is answered by the ROSTER, not by the
  // collection at hand: a pushed target always carries at least the owner's
  // keyring file, whereas `_broker_member` or `_delegations` legitimately
  // become EMPTY when the last record is revoked — and that emptiness is the
  // revocation this must propagate (core#91), not a never-pushed target.
  let remoteInitialised = false
  for (const rule of RESERVED_REPLICATION) {
    const remoteIds = (await remote.list(vault, rule.collection)).filter(id => inScope(rule, id))
    if (rule.collection === KEYRING_COLLECTION) remoteInitialised = remoteIds.length > 0
    const ids = await mirrorRule(rule, remote, local, vault, remoteIds)
    copied += ids.length
    if (rule.collection === KEYRING_COLLECTION) keyringsCopied = ids
    if (!rule.propagateDeletes || !remoteInitialised) continue
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
