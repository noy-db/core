/**
 * **@noy-db/to-file** — JSON file store for NOYDB (USB / local disk).
 *
 * Maps the NOYDB hierarchy directly to the filesystem:
 *
 * ```
 * {dir}/
 *   {vault}/
 *     {collection}/
 *       {id}.json          ← EncryptedEnvelope, optionally pretty-printed
 *     _keyring/
 *       {userId}.json      ← wrapped DEKs for this user
 *     _sync/
 *       meta.json          ← sync metadata
 * ```
 *
 * ## When to use
 *
 * - **USB stick workflow** — the data directory lives on a removable drive.
 *   Plug in, unlock, work offline, eject. No cloud dependency.
 * - **Local development** — simple, inspectable files; no Docker or cloud
 *   credentials required.
 * - **Single-user desktop apps** — Electron, Tauri, or any Node.js app that
 *   writes to a local directory.
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `false` — no atomic compare-and-swap at the FS layer |
 * | `serverWriteTime` | `true` — local filesystem clock; solo-writer only |
 * | `listVaults` | ✓ — enumerates subdirectories |
 * | `listPage` | ✓ — cursor-based pagination over sorted filenames |
 * | `ping` | ✓ — `stat(dir)` |
 *
 * ## Atomicity
 *
 * The filesystem has `rename` but no atomic CAS — `casAtomic` is `false`,
 * and the `expectedVersion` check is read-then-write, so it is advisory
 * under concurrent writers. Per-record writes do go through
 * `{id}.json.{pid}.{n}.tmp` + rename, so a write interrupted partway (a
 * laptop dropping Wi-Fi mid-write to a mounted share, a USB stick pulled
 * during a flush) can never leave a truncated `{id}.json` behind — readers
 * see the complete previous file or the complete new one. Orphaned `.tmp`
 * sidecars from a crashed process are invisible to `list`, `listPage` and
 * `loadAll`, which only accept `.json`.
 *
 * This is atomicity of *visibility*, not durability: surviving a power cut
 * would additionally require fsyncing the file and its directory, which is
 * deliberately not paid per record.
 *
 * ## Pod helpers
 *
 * {@link savePod} and {@link loadPod} are thin wrappers around the hub
 * `writePod` / `readPod` primitives that pipe bytes to/from `node:fs`.
 *
 * @packageDocumentation
 */

import { readFile, mkdir, readdir, rm, unlink, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { atomicWrite } from './atomic-write.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'
import type {
  Vault,
  WritePodOptions,
  PodReadResult,
} from '@noy-db/hub'
import { writePod, readPod, ValidationError } from '@noy-db/hub'

/**
 * Options for `toFile()`.
 *
 * Files are laid out as `{dir}/{vault}/{collection}/{id}.json`.
 * Internal collections (`_keyring`, `_sync`) follow the same pattern
 * under their vault directory.
 */
export interface JsonFileOptions {
  /** Base directory for NOYDB data. */
  dir: string
  /** Pretty-print JSON files. Default: true. */
  pretty?: boolean
  /** Clock uncertainty bound (ms). Default: 0. */
  clockUncertaintyMs?: number
}

/**
 * Create a JSON file adapter.
 * Maps the NOYDB hierarchy to the filesystem:
 *
 * ```
 * {dir}/{vault}/{collection}/{id}.json
 * {dir}/{vault}/_keyring/{userId}.json
 * ```
 */
export function toFile(options: JsonFileOptions): NoydbStore {
  const { dir, pretty = true } = options
  const root = resolve(dir)

  /**
   * Defence in depth for family#133. `join` COLLAPSES `..` rather than refusing it, so
   * `join(dir, '..', c, id)` lands outside `dir` and reads as an ordinary path. Every
   * segment reaches us from a caller, and record ids in particular travel with data —
   * a sync peer, an imported pod, application input.
   *
   * ⚠️ Hub's central check LANDED (family#133's second half —
   * `guardStoreSegments()` around the mounted store), so this is now a backstop
   * rather than the only guard. ⛔ Keep it anyway, which is the whole reason it was
   * written to stand alone: an out-of-tree caller can hold a `NoydbStore` reference
   * without going through hub at all, and this package is published for exactly
   * that kind of consumer.
   *
   * ⛔ Do NOT harden this into "no `/` in an id". Hub itself emits
   * `_idx/<field>/<recordId>` ids for persisted index side-cars (see hub's
   * `persisted-indexes.ts`, which documents ids as slash-bearing on purpose), so
   * refusing the separator would break hub's own writes. Containment is the property;
   * the separator is not.
   */
  function contained(path: string, what: string): string {
    const p = resolve(path)
    if (p !== root && !p.startsWith(root + sep)) {
      throw new ValidationError(`to-file: ${what} resolves outside the store directory`)
    }
    return path
  }

  /**
   * Segment shape, mirroring the rule hub applies at the kernel boundary (family#133).
   *
   * ⚠️ Containment alone is NOT enough, and the cheap guard misses the interesting case:
   * `join(dir, 'v', '..', 'i.json')` is `{dir}/i.json`, which is still INSIDE the store
   * directory. It escapes the VAULT, not the store — and on a multi-tenant mount the
   * vault boundary is the one that matters. So shape is checked per segment and
   * containment stays as the backstop beneath it.
   *
   * `vault` and `collection` are single names: no separator, no `.`/`..`, never empty.
   * `id` MAY carry `/` — hub's index side-cars are `_idx/<field>/<recordId>` — so each
   * of its slash-separated components is checked instead of the whole string.
   */
  function assertName(value: string, what: string): void {
    if (value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
      throw new ValidationError(`to-file: ${what} must be a single path segment, got ${JSON.stringify(value)}`)
    }
  }

  function assertId(id: string): void {
    // ⛔ NUL IS NO LONGER REFUSED (family#174). Hub EMITS it:
    // `resolveSequenceKey`/`resolvePeriodKey` join a partition as
    // `${name}\x00${parts}`, chosen because a NUL cannot occur in a plain
    // series name, so a partitioned key can never collide with an
    // unpartitioned one. Refusing the byte meant a partitioned sequence or
    // period could not be stored here at all — and it never could, since the
    // OS rejects NUL in a path whatever this adapter does. It is now ENCODED
    // (see `encodeIdComponent`), which is why the check below dropped it.
    //
    // ⚠️ A backslash is still refused. Hub never writes one; `listIds` joins
    // entry NAMES with `/` so a backslash in an id would be indistinguishable
    // from a win32 separator on the way back. The store contract explicitly
    // allows a store to reject outright, and this is one.
    if (id.includes('\\')) {
      throw new ValidationError(`to-file: record id must not contain a backslash, got ${JSON.stringify(id)}`)
    }
    for (const part of id.split('/')) {
      if (part === '' || part === '.' || part === '..') {
        throw new ValidationError(`to-file: record id has an empty, "." or ".." component, got ${JSON.stringify(id)}`)
      }
    }
  }

  /**
   * Reversible per-component encoding for a record id (family#174).
   *
   * ⛔ `%` MUST BE ESCAPED FIRST OR THE ENCODING IS NOT A BIJECTION, and the
   * failure is data loss rather than a cosmetic one: without it the literal id
   * `a%00b` and the id `a\x00b` both map to `a%00b.json` — two distinct records,
   * one file. That is why the ruling names `%` alongside NUL.
   *
   * ⚠️ SCOPE IS DELIBERATELY `%` AND NUL, not every character some platform
   * refuses. Each additional character widens the set of EXISTING on-disk names
   * that move: an id containing `:` is storable on POSIX today, so encoding it
   * would relocate live records for a portability benefit nobody asked for.
   * NUL is the one character that cannot be stored today, so encoding it breaks
   * nothing; `%` is the one the encoding itself needs. Widening to the win32
   * reserved set is a separate decision with a wider legacy corner.
   *
   * ⚠️ Applied PER `/`-SEPARATED COMPONENT, never to the whole id: `/` maps to a
   * directory here (hub writes `_idx/<field>/<recordId>`), so encoding it would
   * flatten the nesting that `listIds` walks.
   */
  function encodeIdComponent(part: string): string {
    return part.replace(/%/g, '%25').replace(/\0/g, '%00')
  }

  /** Exact inverse of {@link encodeIdComponent}. ⚠️ ONE PASS, because a
   *  sequential `%00`-then-`%25` replace would turn the literal `%2500` into a
   *  NUL instead of back into `%00`. */
  function decodeIdComponent(part: string): string {
    return part.replace(/%(25|00)/g, (_m, code: string) => (code === '25' ? '%' : '\0'))
  }

  const encodeId = (id: string): string => id.split('/').map(encodeIdComponent).join('/')
  const decodeId = (id: string): string => id.split('/').map(decodeIdComponent).join('/')

  function recordPath(vault: string, collection: string, id: string): string {
    assertName(vault, 'vault')
    assertName(collection, 'collection')
    assertId(id)
    const encoded = encodeId(id)
    return contained(join(dir, vault, collection, `${encoded}.json`), `record "${id}"`)
  }

  /**
   * The pre-family#174 path for an id, for READS only.
   *
   * ⚠️ A backstop against a break the family's closed-format-break rule would
   * otherwise charge to holders of live data. Encoding `%` moves the on-disk
   * name of every existing id that contains one, so a read tries the encoded
   * path and then the legacy raw one. ⛔ It does NOT make `list` lossless for
   * such an id: a legacy `a%3Ab.json` decodes to `a:b`, which still RESOLVES
   * (`get('a:b')` re-encodes to the same file) but is reported under the wrong
   * name. That residual corner is the known price; it is narrow, it is
   * read-only, and nothing becomes unreadable.
   */
  function legacyRecordPath(vault: string, collection: string, id: string): string | null {
    // ⛔ THE FIRST VERSION OF THIS RETURNED ANOTHER RECORD'S CIPHERTEXT, and my
    // own changeset called the residual a cosmetic `list` artefact. It was not.
    // `a%00b` is simultaneously a literal id AND the encoded form of `a\x00b`,
    // so falling back to the raw `a%00b.json` for the literal id handed back the
    // NUL id's record — a CROSS-ID READ. Measured: `get('a%00b')` returned the
    // body written for `a\x00b`.
    //
    // Three conditions, each ruling out a distinct way to be wrong:
    //   1. The id holds no NUL. Such an id could never be stored before the
    //      encoding existed, so it has no legacy copy by construction.
    //   2. The id contains `%`. That is the only character whose encoding MOVED
    //      an existing file; without one there is no legacy name to look for.
    //   3. `encodeId(decodeId(id)) !== id` — the id is not itself a valid
    //      ENCODED form. If it is, the raw path belongs to whatever decodes to
    //      it and never to this id. This is the condition that closes the
    //      cross-id read, and it works because an encoded path can only ever
    //      contain `%25` or `%00`.
    if (id.includes('\0')) return null
    if (!id.includes('%')) return null
    if (encodeId(decodeId(id)) === id) return null
    return contained(join(dir, vault, collection, `${id}.json`), `record "${id}"`)
  }

  /**
   * Read one record by id — encoded path first, legacy raw name second.
   *
   * ⭐ ONE READER FOR `get` AND `loadAll`, because they had drifted and only
   * one of them was right. `loadAll` joined the DECODED id straight into a
   * path, so a NUL-bearing id threw inside its `try` and the WHOLE collection
   * came back empty — which a sync peer reads as every record deleted — while
   * `get` went through `recordPath` and worked. Two readers for one on-disk
   * layout is how that happens; the fix is one reader, not the same correction
   * applied twice.
   */
  async function readRecord(
    vault: string,
    collection: string,
    id: string,
  ): Promise<EncryptedEnvelope | null> {
    const path = recordPath(vault, collection, id)
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as EncryptedEnvelope
    } catch (err) {
      // family#162 — only an ABSENT file may fall through to `null`. A read
      // failure or a corrupt body is reported, because hub reads `null` as "no
      // such record" and will create over it.
      if (!isAbsence(err)) throw err
      const legacy = legacyRecordPath(vault, collection, id)
      if (legacy === null) return null
      try {
        return JSON.parse(await readFile(legacy, 'utf-8')) as EncryptedEnvelope
      } catch (legacyErr) {
        if (!isAbsence(legacyErr)) throw legacyErr
        return null
      }
    }
  }

  /**
   * Unlink a path that may not exist, and report anything else.
   *
   * family#162's write-side rule: deleting what is already gone is the caller's
   * intent already satisfied, but an EACCES or EPERM reported as success is a
   * delete the caller believes happened — and sync and forget both act on that
   * answer. `null` is "there is no such path to consider", not a failure.
   */
  async function unlinkIfPresent(path: string | null): Promise<void> {
    if (path === null) return
    try {
      await unlink(path)
    } catch (err) {
      if (!isAbsence(err)) throw err
    }
  }

  /**
   * Does this filesystem fold case? Probed once, lazily, in the store dir.
   *
   * ⛔ WHY A PROBE AND NOT A PLATFORM CHECK. `process.platform === 'darwin'`
   * is the wrong question twice over: macOS can be formatted case-SENSITIVE,
   * and a case-sensitive Linux host can have a case-folding mount (SMB, a
   * FAT/exFAT volume, a Docker bind mount from a macOS host). The only honest
   * answer comes from the directory the records actually live in.
   *
   * ⚠️ The probe writes one file and reads it back under a differently-cased
   * name, then removes it. It runs at most once per store and is cached even
   * on failure — an unwritable dir is not a case question, and re-probing on
   * every write would make a cold store slower for no information.
   */
  let foldsCase: boolean | null = null

  /**
   * A tag unique to THIS store instance, so two stores probing one directory
   * cannot touch each other's sentinel (family#217).
   *
   * ⛔ THE FIXED NAME WAS A RACE THAT FAILED CLOSED, PERMANENTLY. Both stores
   * probed `.noydb-case-probe-Aa`: B's `mkdir(…, { recursive: true })`
   * SUCCEEDS on the directory A had just created — that is what `recursive`
   * means — and B's `finally` then removes it. If that lands between A's
   * `mkdir` and A's `stat`, A sees no folded counterpart, concludes
   * case-SENSITIVE, and caches it for the store's whole lifetime. Every later
   * `assertNoCaseCollision` short-circuits, and the collapse this adapter
   * exists to refuse goes through silently.
   *
   * ⚠️ Lowercase and digits only, and the SAME tag in both spellings. The two
   * probe names must differ in nothing but the `Aa`/`aa`, or the stat is
   * answering a different question.
   */
  const probeTag = `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`
  async function filesystemFoldsCase(): Promise<boolean> {
    if (foldsCase !== null) return foldsCase
    const probe = join(root, `.noydb-case-probe-Aa-${probeTag}`)
    try {
      await mkdir(root, { recursive: true })
      // ⛔ A DIRECTORY, PROBED WITH `stat` — NO FILE WRITE AT ALL. Two earlier
      // shapes both changed what they measured:
      //   - `atomicWrite` consumed a test's injected write failure
      //     (`atomic-write.test.ts` tears the FIRST write to simulate an
      //     interruption), so the real put then succeeded and two cases that
      //     assert a rejection stopped seeing one;
      //   - plain `writeFile` did the same, because the mock is at the
      //     `node:fs/promises` layer, not at this adapter's.
      // A diagnostic that spends the caller's first write is a diagnostic that
      // changes the thing it is diagnosing. `mkdir` + `stat` touches neither.
      await mkdir(probe, { recursive: true })
      foldsCase = await stat(join(root, `.noydb-case-probe-aa-${probeTag}`))
        .then(() => true)
        .catch(() => false)
    } catch {
      // Cannot probe (read-only dir, permissions). Assume NOT folding: a false
      // positive would refuse legitimate writes on a case-sensitive store,
      // which is worse than leaving the collapse detectable downstream — hub's
      // AAD binds the id, so a folded read surfaces as TamperedError rather
      // than as wrong plaintext.
      foldsCase = false
    } finally {
      await rm(probe, { recursive: true, force: true })
    }
    return foldsCase
  }

  /**
   * Refuse a write whose id case-folds onto a DIFFERENT existing id (family#177).
   *
   * ⛔ THE COLLAPSE IS SILENT AND THE SURVIVOR IS A CHIMERA. Measured outside
   * noy-db entirely — `printf 'UPPER' > Abc.json`, `printf 'lower' > abc.json`
   * leaves ONE file named `Abc.json` containing `lower`. The entry keeps the
   * FIRST id's name and the SECOND id's content, which is exactly the shape
   * MySQL's case-insensitive collation produced for `to-mysql`.
   *
   * ⚠️ REFUSING, not re-encoding. Encoding case into the filename would move
   * every existing record whose id has an uppercase letter — a storage-format
   * break with a migration attached — and this adapter's contract already
   * allows a store to reject an id it cannot represent.
   */
  async function assertNoCaseCollision(vault: string, collection: string, id: string): Promise<void> {
    if (!await filesystemFoldsCase()) return
    // ⛔ EVERY COMPONENT, NOT THE LEAF (family#217). `encodeId` maps `/` to `/`
    // on purpose — a side-car id like `_idx/<field>/<recordId>` NESTS — so a
    // folded DIRECTORY component collapses two distinct ids just as completely
    // as a folded filename, one level up where a leaf-only check cannot see it.
    // Measured: with `A/x` on disk, writing `a/x` found parent `…/a` (which the
    // filesystem resolved to `…/A`), read `['x.json']`, compared it against its
    // own leaf `x.json`, found them EQUAL, and returned clean — then wrote
    // `a/x`'s body into `A/x`. The leaf check cannot fire here, because at the
    // leaf there is nothing wrong.
    const encoded = encodeId(id)
    const parts = encoded.split('/')
    parts[parts.length - 1] = `${parts[parts.length - 1]}.json`
    let current = join(dir, vault, collection)
    for (const [index, part] of parts.entries()) {
      const isLeaf = index === parts.length - 1
      let entries: string[]
      try {
        entries = await readdir(current)
      } catch (err) {
        if (isAbsence(err)) return // nothing to collide with yet
        throw err
      }
      const folded = part.toLowerCase()
      for (const entry of entries) {
        if (entry === part || entry.toLowerCase() !== folded) continue
        // Name the thing the caller can act on: the record for a leaf, the
        // folded path PREFIX for a directory. Decoding `entry` as an id only
        // makes sense for a leaf — on a directory it would strip a `.json`
        // that is not there.
        const existing = isLeaf
          ? JSON.stringify(decodeId([...parts.slice(0, index), entry.slice(0, -5)].join('/')))
          : `${JSON.stringify(decodeId([...parts.slice(0, index), entry].join('/')))} (a directory component)`
        throw new ValidationError(
          `to-file: record id ${JSON.stringify(id)} case-folds onto the existing `
          + `${existing} on a case-insensitive filesystem, `
          + `so writing it would REPLACE that record's body while keeping its name. `
          + `Refusing. Use ids that differ by more than case, or mount the store on a `
          + `case-sensitive filesystem.`,
        )
      }
      current = join(current, part)
    }
  }

  function collectionDir(vault: string, collection: string): string {
    assertName(vault, 'vault')
    assertName(collection, 'collection')
    return contained(join(dir, vault, collection), `collection "${collection}"`)
  }

  /**
   * Every record id under a collection, nested ones included (family#133).
   *
   * ⛔ A flat `readdir` is WRONG here, and it was wrong in four methods: a
   * slash-bearing id is a nested FILE, so `_idx/email/u1` lives at
   * `{coll}/_idx/email/u1.json` and a one-level listing cannot see it. Hub calls
   * `list()` to bulk-load the persisted-index mirror and filters side-cars out
   * itself (`isIdxId`'s docstring says so), so a store that hides them does not
   * look tidier — it reports a collection as missing its own indexes.
   *
   * The returned ids are joined with `/` from directory entry NAMES, never from a
   * platform path, so they round-trip on win32 where `sep` is a backslash — and an
   * id containing a backslash is refused at the door by `assertId`.
   */
  async function listIds(vault: string, collection: string): Promise<string[]> {
    const base = collectionDir(vault, collection)
    const ids: string[] = []
    async function walk(rel: string): Promise<void> {
      let entries
      try {
        entries = await readdir(rel ? join(base, rel) : base, { withFileTypes: true })
      } catch (err) {
        // family#162 — ABSENCE is nothing to list; a FAILURE is not.
        if (isAbsence(err)) return
        throw err
      }
      for (const entry of entries) {
        const next = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) { await walk(next); continue }
        // family#174 — DECODE on the way out. An encoding with no matching
        // decode makes `list` report an id that no `get` resolves, so
        // `loadAll`, sync enumeration and export all see a phantom key.
        if (entry.name.endsWith('.json')) ids.push(decodeId(next.slice(0, -5)))
      }
    }
    await walk('')
    return ids
  }

  async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  /**
   * Is this error "the thing is not there", as opposed to "I could not read it"?
   *
   * ⛔ THE DISTINCTION IS LOAD-BEARING, and collapsing it is family#162. Every
   * read here used to answer a FAILURE with the same value as an ABSENCE —
   * `null` from `get`, `[]` from `list`, `{}` from `loadAll`. Hub cannot tell
   * those apart, and it has a fail-closed gate that depends on doing so:
   * `assertKeyringOpenAllowed` refuses to self-provision into a vault held by
   * other principals by checking `list(vault, '_keyring')` for emptiness. An
   * EACCES on the vault directory returned `[]`, the gate read that as "a
   * genuinely-new vault", and hub provisioned a second owner into a vault that
   * already had one.
   *
   * ⚠️ ENOENT and ENOTDIR only. ENOTDIR because a path component that is a file
   * rather than a directory means the collection cannot exist either — but
   * EACCES, EIO, EMFILE, ELOOP and a corrupt JSON body are all "could not
   * read", and every one of them must reach the caller.
   */
  function isAbsence(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }


  function serialize(envelope: EncryptedEnvelope): string {
    return pretty ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope)
  }

  return {
    name: 'file',
    capabilities: {
      casAtomic: false,
      serverWriteTime: true,
      auth: { kind: 'filesystem', required: false, flow: 'static' },
    },

    async getStoreTime() {
      const now = Date.now()
      const ε = options.clockUncertaintyMs ?? 0
      return { earliest: now - ε, latest: now + ε }
    },

    async get(vault, collection, id) {
      return readRecord(vault, collection, id)
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const path = recordPath(vault, collection, id)

      if (expectedVersion !== undefined) {
        // family#147 — an absent record is at version 0, so the comparison runs
        // whether or not the file exists: `0 === 0` creates (core#134), and a
        // NONZERO expectation against nothing conflicts instead of upserting.
        // ⚠️ Still advisory, not atomic — `capabilities.casAtomic` is false here
        // because this read and the write below can interleave with another writer.
        // ⚠️ THE LEGACY PATH COUNTS FOR THE CAS TOO. Reading only the encoded
        // name made a legacy `%`-bearing id report version 0, so every versioned
        // put against it conflicted FOREVER — measured: `get` saw `_v: 3` and
        // `put` expecting 3 was told "found 0". A record that is readable but
        // unwritable is worse than one that is neither, because nothing surfaces
        // until a caller tries to change it.
        const existing = await readRecord(vault, collection, id)
        const current = existing?._v ?? 0
        if (current !== expectedVersion) {
          throw new ConflictError(current, `Version conflict: expected ${expectedVersion}, found ${current}`)
        }
      }

      // family#133 — the id's parent, not the collection dir: a side-car id like
      // `_idx/<field>/<recordId>` nests below the collection, and the atomic write
      // failed with ENOENT on its `.tmp` leaf because nothing created that directory.
      // Persisted indexing therefore never worked on a to-file mount.
      await assertNoCaseCollision(vault, collection, id)
      await ensureDir(dirname(path))
      await atomicWrite(path, serialize(envelope))
      // ⛔ DROP THE RAW COPY ON WRITE. Leaving it meant two files for one id,
      // and `list` reports both — so a record that had been rewritten came back
      // twice, under its real name and under the decoded legacy one. Converging
      // on write is also what makes the fallback above a MIGRATION rather than a
      // permanent second lookup path.
      await unlinkIfPresent(legacyRecordPath(vault, collection, id))
    },

    async delete(vault, collection, id) {
      // ⛔ BOTH NAMES. Deleting only the encoded path left the legacy copy
      // standing, and `list` still reported it — so a deleted record RESURFACED
      // on the next listing, and a sync peer would re-create it.
      await unlinkIfPresent(recordPath(vault, collection, id))
      await unlinkIfPresent(legacyRecordPath(vault, collection, id))
    },

    async list(vault, collection) {
      return listIds(vault, collection)
    },

    async loadAll(vault) {
      const compDir = join(dir, vault)
      const snapshot: VaultSnapshot = {}

      try {
        const collections = await readdir(compDir)
        for (const collName of collections) {
          if (collName.startsWith('_')) continue // skip _keyring, _sync
          const collPath = join(compDir, collName)
          const collStat = await stat(collPath)
          if (!collStat.isDirectory()) continue

          const records: Record<string, EncryptedEnvelope> = {}
          for (const id of await listIds(vault, collName)) {
            // ⛔ THROUGH `readRecord`, NEVER `join(collPath, id)`. `listIds`
            // returns DECODED ids, so joining one straight into a path put a
            // raw NUL in a filename — which throws, inside this `try`, which
            // abandoned the WHOLE collection. Measured: a vault holding one
            // NUL-bearing id and one ordinary record returned an EMPTY
            // snapshot, and a sync peer reads that as every record deleted.
            const envelope = await readRecord(vault, collName, id)
            if (envelope !== null) records[id] = envelope
          }
          snapshot[collName] = records
        }
      } catch (err) {
        // family#162 — an ABSENT vault directory is an empty snapshot. Anything
        // else is a read failure, and an empty snapshot is how hub concludes a
        // vault has no records at all.
        if (!isAbsence(err)) throw err
      }

      return snapshot
    },

    async saveAll(vault, data) {
      // family#147 — `saveAll` REPLACES: it is the restore half of `loadAll`, and a
      // merge cannot express "this collection is gone", so anything the snapshot
      // omits goes. An EMPTY record set therefore empties its collection.
      //
      // ⛔ WRITE FIRST, PRUNE SECOND — the order is the crash contract, not style.
      // Deleting first and writing after passes every conformance case and loses
      // data: `atomic-write.test.ts` case 5 tears the write mid-call, and a
      // delete-then-write `saveAll` leaves the record GONE where the additive one
      // left the previous version standing. Writing first means a torn call leaves
      // STALE EXTRA records — recoverable by re-running the restore — instead of a
      // hole. ⚠️ This is why the kit asserts the OUTCOME and not the mechanism:
      // hub's `memoryStore` can delete first because nothing can crash between two
      // synchronous Map operations, and to-browser-idb does both inside ONE
      // readwrite transaction. On a filesystem neither is available.
      //
      // Reserved (`_`-prefixed) collections are never pruned — a partial snapshot
      // must not strand `_keyring` — but ARE overwritten when the snapshot carries
      // them, which is what makes a full restore possible.
      // ⛔⛔ DATA LOSS, AND THE PRUNE WAS THE KNIFE (family#217). `saveAll` never
      // ran the case-collision guard, so on a folding filesystem a snapshot
      // carrying `abc` against an on-disk `Abc` wrote abc's body INTO
      // `Abc.json`, and then the prune below asked `'Abc' in records` — false,
      // because the snapshot says `abc` — and unlinked the very file it had
      // just written. Measured on APFS against to-file@0.10.0-pre.2:
      // `put('Abc')` then `saveAll({ c: { abc } })` leaves `list` EMPTY and
      // `get('abc')` null. Both records gone, no error raised.
      //
      // ⭐ ASSERTED IN FULL BEFORE ANYTHING IS WRITTEN, deliberately. Checking
      // inside the write loop would refuse correctly and leave a restore torn
      // at whichever id tripped — earlier records written, later ones not. The
      // write-first ordering below accepts a torn call (stale extras, which a
      // re-run fixes) but a torn REFUSAL is not the same thing: it is a
      // half-applied snapshot produced by a call that reported failure. One
      // pre-pass costs a readdir per directory and makes a refusal total.
      for (const [collName, records] of Object.entries(data)) {
        for (const id of Object.keys(records)) {
          await assertNoCaseCollision(vault, collName, id)
        }
      }

      for (const [collName, records] of Object.entries(data)) {
        await ensureDir(collectionDir(vault, collName))
        for (const [id, envelope] of Object.entries(records)) {
          // family#133 — a nested id needs its own parent, not just the collection
          // directory; `saveAll` had `put`'s ENOENT bug for the same reason.
          const path = recordPath(vault, collName, id)
          await ensureDir(dirname(path))
          await atomicWrite(path, serialize(envelope))
        }
      }

      try {
        for (const entry of await readdir(join(dir, vault), { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('_')) continue
          const records = data[entry.name]
          if (records === undefined) {
            await rm(collectionDir(vault, entry.name), { recursive: true, force: true })
            continue
          }
          for (const id of await listIds(vault, entry.name)) {
            if (!(id in records)) await unlink(recordPath(vault, entry.name, id))
          }
        }
      } catch {
        // No vault directory — an empty snapshot into a vault that does not exist.
      }
    },

    async ping() {
      try {
        await stat(dir)
        return true
      } catch {
        return false
      }
    },

    /**
     * Enumerate every top-level vault subdirectory under the
     * configured base directory. Used by
     * `Noydb.listAccessibleVaults()`.
     *
     * The implementation is `readdir(dir)` filtered to entries that
     * are themselves directories — files at the top level (READMEs,
     * .DS_Store, etc.) are skipped, and missing base directory
     * returns an empty array rather than throwing. Result order is
     * filesystem-defined; consumers that want stable order should
     * sort themselves.
     */
    async listVaults() {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        return []
      }
      const compartments: string[] = []
      for (const entry of entries) {
        try {
          const entryStat = await stat(join(dir, entry))
          if (entryStat.isDirectory()) compartments.push(entry)
        } catch {
          // Entry vanished between readdir and stat — skip silently.
        }
      }
      return compartments
    },

    /**
     * Paginate over a collection. Cursor is a numeric offset (as a string)
     * into the sorted filename list. Files are sorted alphabetically so
     * pages are stable across runs and across processes that share the
     * same data directory.
     *
     * The default `limit` is 100. Each item carries its decoded envelope
     * so callers don't need an extra `get()` round-trip per id.
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const ids = (await listIds(vault, collection)).sort()

      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        try {
          const content = await readFile(recordPath(vault, collection, id), 'utf-8')
          items.push({ id, envelope: JSON.parse(content) as EncryptedEnvelope })
        } catch {
          // File disappeared between readdir and readFile — skip silently.
        }
      }

      return {
        items,
        nextCursor: end < ids.length ? String(end) : null,
      }
    },
  }
}

// ─── Store-locator descriptor (#945 — `local`-class reference impl) ──

/**
 * Builds the `StoreDescriptor` form of a `toFile()` store: `kind: 'file'`,
 * `class: 'local'`, and a serializable `address` carrying the base
 * directory (same value `JsonFileOptions.dir` would take directly).
 *
 * Credentialless — `to-file` never needs a `StoreCredentialSource`.
 */
export function fileStoreDescriptor(dir: string): StoreDescriptor {
  return { kind: 'file', class: 'local', address: { dir } }
}

/**
 * `StoreFactory` for `to-file`: reconstructs the same store `toFile()`
 * builds, from a `StoreDescriptor` (as produced by {@link fileStoreDescriptor}).
 *
 * `to-file` is a credentialless local store, so `opts.credentials` is
 * unused. `opts.binding` may carry a device-local directory override — a
 * bare string or `{ dir }` — applied in place of `descriptor.address.dir`
 * when present (e.g. a different mount point on this device than what the
 * descriptor was authored with).
 */
export const fileStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as { dir: string }
  const binding = opts.binding as { dir?: string } | string | undefined

  let dir: string
  if (typeof binding === 'string') {
    dir = binding
  } else if (binding && binding.dir !== undefined) {
    dir = binding.dir
  } else {
    dir = address.dir
  }

  return toFile({ dir })
}

/** Registers {@link fileStoreFactory} under the `'file'` kind on `locator`. */
export function registerFileStore(locator: StoreLocator): void {
  locator.register('file', fileStoreFactory)
}

// ─── .noydb pod helpers ────────────────────────────────────

/**
 * Write a `.noydb` container for a vault to a local file.
 *
 * Thin wrapper around `writePod` from `@noy-db/hub` — the hub
 * primitive returns a `Uint8Array`, this helper just pipes it to
 * disk after ensuring the parent directory exists. Use the same
 * options as the hub primitive.
 *
 * **Path convention** is up to the caller — `.noydb` is the
 * recommended extension. Consumers using cloud-sync folders
 * should name files by the bundle handle (available via
 * `vault.getPodHandle()`) rather than the vault
 * name to avoid leaking metadata at the filesystem layer:
 *
 * ```ts
 * const handle = await company.getPodHandle()
 * await savePod(`./pods/${handle}.noydb`, company)
 * ```
 *
 * The container is staged in a `.tmp` sidecar and renamed into
 * place (#1040), so a reader — or a cloud-sync daemon watching the
 * folder — never observes a partially-written pod under its final
 * name. A pod is past `PIPE_BUF` essentially always, so the
 * previous bare `writeFile` genuinely did race with concurrent
 * readers despite the docstring that claimed otherwise.
 */
export async function savePod(
  path: string,
  vault: Vault,
  opts: WritePodOptions = {},
): Promise<void> {
  const bytes = await writePod(vault, opts)
  // Ensure the parent directory exists — the write does NOT
  // create intermediate directories on its own. Recursive mkdir
  // is a no-op when the directory already exists.
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, bytes)
}

/**
 * Read and verify a `.noydb` container from a local file.
 *
 * Returns the parsed header plus the unwrapped `dump()` JSON
 * string ready to feed to `vault.load(json, secret)`.
 * Throws `PodIntegrityError` from `@noy-db/hub` if the body
 * bytes don't match the integrity hash declared in the header
 * (the pod was modified between write and read), or any
 * format error from the hub reader if the bytes aren't a valid
 * pod at all.
 *
 * Does NOT take a secret — the pod reader is purely a
 * format layer. Restoring a vault from the returned dump
 * JSON requires a separate `vault.load()` call with the
 * secret, mirroring the split between
 * `readPod()` and `vault.load()` in hub.
 */
export async function loadPod(path: string): Promise<PodReadResult> {
  const bytes = await readFile(path)
  // node:fs.readFile returns a Buffer, which is a Uint8Array
  // subclass — `readPod` accepts Uint8Array directly,
  // no copy needed.
  return readPod(bytes)
}


// Export-blobs FS materializer — wraps `vault.exportBlobs()` with
// target-profile filename sanitization, Zip-Slip path containment, and
// collision policy. Lives in `to-file` (not core) because hub stays
// portable across browser/Node and shouldn't import `node:fs`.
export {
  exportBlobsToDirectory,
} from './export-blobs-to-directory.js'
export type {
  ExportBlobsToDirectoryOptions,
  ExportBlobsToDirectoryResult,
  CollisionStrategy,
} from './export-blobs-to-directory.js'
