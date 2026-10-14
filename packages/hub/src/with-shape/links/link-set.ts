/**
 * `_links_*` reserved collections — managed bidirectional many-to-many
 * junctions (design B).
 *
 * Where `refArray` (design A) stores an id-array on one owning record,
 * `vault.link()` creates a first-class junction: a dedicated encrypted
 * `_links_<name>` collection whose rows are `{ a, b, meta? }` link tuples.
 * It is queryable from BOTH sides (`of(id)`), carries optional per-link
 * metadata, and cascades on endpoint delete.
 *
 * Each link is slot-typed: `a` is an id in the `a` endpoint collection,
 * `b` an id in the `b` endpoint collection (they may be the same
 * collection for self-links). A link's identity is the ordered pair
 * `(a, b)`; `of(id)` matches either slot.
 *
 * Rows are encrypted under a dedicated `_links_<name>` DEK — same
 * zero-knowledge stack as every other collection (the store sees only
 * ciphertext). Backup/restore rides the normal `loadAll` path.
 */

import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import { buildRecordAad, buildRecordEnvelope, encrypt, openEnvelopeJson, type EnclaveKey } from '../../capsule/index.js'
import { NoydbError } from '../../kernel/errors.js'

// Naming helpers, declaration types, and LinkIntegrityError live in
// `names.ts` (the always-loadable slice — #553); re-exported here so
// existing import paths and the root barrel are unchanged.
export {
  LINK_COLLECTION_PREFIX,
  linkCollectionName,
  isLinkCollectionName,
  linkRowKey,
  LinkIntegrityError,
} from './names.js'
export type { LinkOnDelete, LinkSpec, LinkRow, LinkSetHandle } from './names.js'
import { linkCollectionName, linkRowKey } from './names.js'
import type { LinkSpec, LinkRow, LinkSetHandle } from './names.js'

/** Stored form (also the row key derivation source). */
interface LinkEntry {
  a: string
  b: string
  meta?: Record<string, unknown>
}

/**
 * @internal — the concrete handle. The Vault owns construction (one per
 * link name) and the cascade hooks; consumers use the {@link LinkSetHandle}
 * surface via `vault.links(name)`.
 */
export class LinkSet implements LinkSetHandle {
  private readonly collName: string
  private dekPromise: Promise<EnclaveKey> | null = null

  constructor(
    private readonly adapter: NoydbStore,
    private readonly vault: string,
    private readonly name: string,
    private readonly spec: LinkSpec,
    private readonly encrypted: boolean,
    private readonly getDEK: (collectionName: string) => Promise<EnclaveKey>,
    private readonly actor: string,
    private readonly emitter: NoydbEventEmitter,
    /** Vault-provided existence check for endpoint validation on connect(). */
    private readonly endpointExists: (collection: string, id: string) => Promise<boolean>,
  ) {
    this.collName = linkCollectionName(name)
  }

  private dek(): Promise<EnclaveKey> {
    if (!this.dekPromise) this.dekPromise = this.getDEK(this.collName)
    return this.dekPromise
  }

  private async encryptEntry(
    entry: LinkEntry,
    version: number,
    key: string,
    /** family#210 — stamp `_del` so the row is a REMOVAL, not a link. */
    removed = false,
  ): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(entry)
    const identity = { collection: this.collName, id: key, by: this.actor, version }
    const seal = this.encrypted
      ? await encrypt(json, await this.dek(), buildRecordAad(identity))
      : { iv: '', data: json }
    const env = buildRecordEnvelope(identity, seal)
    // `_del` on the ENVELOPE, not a field in the body: it is hub's existing
    // delete-marker convention (#589), the one `@noy-db/ports`' `/to` suite
    // already requires every store to round-trip byte-identically. A body
    // field would be invisible to anything that cannot decrypt — including
    // the sync mover, which is the whole point of putting it here.
    return removed ? { ...env, _del: true } : env
  }

  /** family#210 — a removal marker, not a live link. See {@link disconnect}. */
  private static isRemoved(env: EncryptedEnvelope): boolean {
    return env._del === true
  }

  private async decryptEntry(key: string, env: EncryptedEnvelope): Promise<LinkEntry> {
    const json = this.encrypted ? await openEnvelopeJson({ collection: this.collName, id: key }, env, await this.dek()) : (env._data ?? '')
    return JSON.parse(json) as LinkEntry
  }

  async connect(aId: string, bId: string, meta?: Record<string, unknown>): Promise<void> {
    if (!(await this.endpointExists(this.spec.a, aId))) {
      throw new LinkEndpointError(this.name, this.spec.a, aId)
    }
    if (!(await this.endpointExists(this.spec.b, bId))) {
      throw new LinkEndpointError(this.name, this.spec.b, bId)
    }
    const key = linkRowKey(aId, bId)
    const entry: LinkEntry = meta !== undefined ? { a: aId, b: bId, meta } : { a: aId, b: bId }
    const existing = await this.adapter.get(this.vault, this.collName, key)
    const env = await this.encryptEntry(entry, (existing?._v ?? 0) + 1, key)
    await this.adapter.put(this.vault, this.collName, key, env, existing?._v)
    this.emitter.emit('change', { vault: this.vault, collection: this.collName, id: key, action: 'put' })
  }

  /**
   * Remove a link.
   *
   * ⛔ WRITES A TOMBSTONE, it does not delete the row (family#210, ruled). A
   * physical delete cannot replicate: the reserved mirror infers removal from
   * ABSENCE, and absence is ambiguous for a set both devices can add to — A
   * disconnecting `x–y` while B connects it is indistinguishable from B simply
   * not having seen it yet. A marker says *removed here, at this version*,
   * which the version comparison can then resolve like any other row.
   *
   * The body is still `{ a, b }`, so the row stays decryptable and the AAD is
   * unchanged; only `_del` on the envelope distinguishes it.
   */
  async disconnect(aId: string, bId: string): Promise<void> {
    const key = linkRowKey(aId, bId)
    const existing = await this.adapter.get(this.vault, this.collName, key)
    if (!existing) return
    if (LinkSet.isRemoved(existing)) return // already removed — idempotent, and no version churn
    const marker = await this.encryptEntry({ a: aId, b: bId }, existing._v + 1, key, true)
    await this.adapter.put(this.vault, this.collName, key, marker, existing._v)
    this.emitter.emit('change', { vault: this.vault, collection: this.collName, id: key, action: 'delete' })
  }

  async has(aId: string, bId: string): Promise<boolean> {
    const env = await this.adapter.get(this.vault, this.collName, linkRowKey(aId, bId))
    // ⚠️ A tombstone is a row that EXISTS, so the old `!== null` answered true
    // for a removed link. Every read path has to know about `_del`, not just
    // `list()`.
    return env !== null && !LinkSet.isRemoved(env)
  }

  async of(id: string): Promise<LinkRow[]> {
    const rows = await this.list()
    return rows.filter((r) => r.a === id || r.b === id)
  }

  async list(): Promise<LinkRow[]> {
    const keys = await this.adapter.list(this.vault, this.collName)
    const out: LinkRow[] = []
    for (const key of keys) {
      const env = await this.adapter.get(this.vault, this.collName, key)
      if (!env) continue
      if (LinkSet.isRemoved(env)) continue // family#210 — a removal, not a link
      const e = await this.decryptEntry(key, env)
      out.push(e.meta !== undefined ? { a: e.a, b: e.b, meta: e.meta } : { a: e.a, b: e.b })
    }
    return out
  }

  // ── Vault-internal cascade helpers ──────────────────────────────────

  /** @internal — rows where the deleted endpoint id matches the relevant slot. */
  async _rowsTouchingEndpoint(collection: string, id: string): Promise<LinkRow[]> {
    const rows = await this.list()
    return rows.filter(
      (r) => (this.spec.a === collection && r.a === id) || (this.spec.b === collection && r.b === id),
    )
  }

  /** @internal — the storage collection name (for tx pre-image capture). */
  get _collectionName(): string {
    return this.collName
  }
}

/** Thrown by `connect()` when an endpoint record does not exist. */
export class LinkEndpointError extends NoydbError {
  readonly link: string
  readonly endpoint: string
  readonly missingId: string
  constructor(link: string, endpoint: string, missingId: string) {
    super(
      'LINK_ENDPOINT',
      `link("${link}").connect: endpoint "${endpoint}" has no record "${missingId}".`,
    )
    this.name = 'LinkEndpointError'
    this.link = link
    this.endpoint = endpoint
    this.missingId = missingId
  }
}
