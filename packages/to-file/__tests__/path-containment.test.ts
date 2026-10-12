/**
 * family#133 — to-file maps the NOYDB hierarchy onto filesystem paths, and
 * `join` COLLAPSES `..` rather than refusing it. One row per segment, because
 * a guard on `vault` alone leaves `id` open — and `id` is the segment that
 * travels with data (a sync peer, an imported pod, application input).
 *
 * The slash case is the control that keeps the guard honest: hub emits
 * `_idx/<field>/<recordId>` ids for persisted index side-cars, so a store that
 * refused the separator would break hub's own writes. Containment is the
 * property under test; the separator is not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ValidationError } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub/to'
import { toFile } from '../src/index.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'to-file-containment-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const ENV: EncryptedEnvelope = { _noydb: 1, _v: 1, _ts: '2026-10-12T00:00:00Z', _iv: '', _data: '{}' }

describe('family#133 — path containment', () => {
  it('refuses a traversal in EVERY segment, not just the vault', async () => {
    const store = toFile({ dir })
    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ['..', 'c', 'i'],                              // vault
      ['../../etc', 'passwd', 'x'],                  // vault, deeper
      ['v', '..', 'i'],                              // collection
      ['v', 'c', '../../../../etc/passwd'],          // id — the reachable one
    ]
    for (const [v, c, id] of rows) {
      await expect(store.put(v, c, id, ENV), `put ${v}/${c}/${id}`).rejects.toBeInstanceOf(ValidationError)
      await expect(store.get(v, c, id), `get ${v}/${c}/${id}`).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('refuses a NUL byte in a VAULT or COLLECTION name with a typed error', async () => {
    // ⚠️ Names only. This case asserted the same for an ID until family#174,
    // which was correct behaviour for a filesystem and the wrong answer for the
    // contract: hub EMITS NUL-bearing ids (`resolveSequenceKey` joins a
    // partition as `${name}\x00${parts}`), so refusing them meant a partitioned
    // sequence or period could not be stored here at all. A vault or collection
    // is a single directory name and hub never puts a NUL in one, so refusing
    // is still right there.
    const store = toFile({ dir })
    await expect(store.put('a\0b', 'c', 'i', ENV)).rejects.toBeInstanceOf(ValidationError)
    await expect(store.put('v', 'a\0b', 'i', ENV)).rejects.toBeInstanceOf(ValidationError)
  })

  it('⭐ family#174 — a NUL-bearing id round-trips, and is a DISTINCT key', async () => {
    const store = toFile({ dir })
    await store.put('acme', 'seq', 'invoice\u00002026/EU', ENV)
    expect(await store.get('acme', 'seq', 'invoice\u00002026/EU')).toMatchObject({ _v: 1 })
    expect(await store.list('acme', 'seq')).toContain('invoice\u00002026/EU')
    // The property hub chose NUL for: a partitioned key can never collide with
    // the unpartitioned one. An encoding that DROPPED the byte would merge them.
    expect(await store.get('acme', 'seq', 'invoice2026/EU')).toBeNull()
  })

  it('⭐ family#174 — the encoding is reversible, so a literal "%" survives too', async () => {
    // ⛔ THE BIJECTION CASE. Without escaping `%` first, the literal id `a%00b`
    // and the id `a\x00b` both land in `a%00b.json` — two records, one file.
    const store = toFile({ dir })
    await store.put('acme', 'c', 'a%00b', { ...ENV, _v: 7 })
    await store.put('acme', 'c', 'a\u0000b', { ...ENV, _v: 9 })
    expect(await store.get('acme', 'c', 'a%00b')).toMatchObject({ _v: 7 })
    expect(await store.get('acme', 'c', 'a\u0000b')).toMatchObject({ _v: 9 })
    expect((await store.list('acme', 'c')).sort()).toEqual(['a%00b', 'a\u0000b'].sort())
  })

  it('⭐ family#174 — a record written under the PRE-encoding name still reads', async () => {
    // The closed-format-break rule, honoured rather than noted: encoding `%`
    // moves the on-disk name of every existing id containing one, so `get`
    // falls back to the legacy raw path. Simulated by writing the legacy file
    // directly, which is exactly what an older to-file left behind.
    const store = toFile({ dir })
    await mkdir(join(dir, 'acme', 'legacy'), { recursive: true })
    await writeFile(join(dir, 'acme', 'legacy', 'a%3Ab.json'), JSON.stringify({ ...ENV, _v: 3 }))
    expect(await store.get('acme', 'legacy', 'a%3Ab'), 'a live record became unreadable').toMatchObject({ _v: 3 })
  })

  it('control: a side-car-shaped id still round-trips — hub emits these', async () => {
    // Before family#133 this threw ENOENT on the atomic-write `.tmp` leaf, because
    // `put` created the collection directory and never the id's parent. Persisted
    // indexing therefore never worked on a to-file mount.
    const store = toFile({ dir })
    await store.put('acme', 'invoices', '_idx/email/u1', ENV)
    expect(await store.get('acme', 'invoices', '_idx/email/u1')).toMatchObject({ _v: 1 })
    expect(existsSync(join(dir, 'acme', 'invoices', '_idx', 'email', 'u1.json'))).toBe(true)
  })

  it('control: an ordinary record is unaffected, and nothing lands outside dir', async () => {
    const store = toFile({ dir })
    await store.put('acme', 'invoices', 'inv-1', ENV)
    const raw = JSON.parse(await readFile(join(dir, 'acme', 'invoices', 'inv-1.json'), 'utf8')) as EncryptedEnvelope
    expect(raw._v).toBe(1)
    expect(await store.list('acme', 'invoices')).toContain('inv-1')
  })
})
