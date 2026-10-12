/**
 * family#162 — this adapter answered every read failure with the ABSENT value.
 *
 * ⛔ WHY THAT IS NOT A TIDY DEFAULT. Hub reads `null` from `get` as "no such
 * record" and `[]` from `list` as "no such collection", and it ACTS on those:
 * `assertKeyringOpenAllowed` refuses to self-provision into a vault held by
 * other principals by checking `list(vault, '_keyring')` for emptiness, so an
 * EACCES on the vault directory made the gate read a populated vault as a new
 * one. A corrupt record body was worse in a quieter way: `get` returned `null`,
 * so the record read as absent and the next write replaced it.
 *
 * ⚠️ A CORRUPT BODY IS THE INJECTABLE CASE, and it is also the realistic one — a
 * torn write leaves exactly that. An EACCES case would need `chmod`, which does
 * nothing when the suite runs as root, so it would be a case that passes by not
 * applying. The classification (`isAbsence`) is what both share.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toFile } from '../src/index.js'
import type { EncryptedEnvelope } from '@noy-db/hub'

const ENV: EncryptedEnvelope = { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'y' }

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nf162-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('family#162 — absence and failure are different answers', () => {
  it('⛔ a CORRUPT record body throws instead of reading as absent', async () => {
    // Before: `get` returned null, hub concluded "no such record", and the next
    // write replaced a record whose bytes were merely unreadable.
    const store = toFile({ dir })
    await mkdir(join(dir, 'acme', 'rows'), { recursive: true })
    await writeFile(join(dir, 'acme', 'rows', 'r1.json'), '{ this is not json')

    await expect(store.get('acme', 'rows', 'r1')).rejects.toThrow()
  })

  it('⛔ a corrupt body inside loadAll throws instead of yielding a short snapshot', async () => {
    // A snapshot missing a record is how a sync peer concludes it was deleted.
    const store = toFile({ dir })
    await store.put('acme', 'rows', 'ok', ENV)
    await writeFile(join(dir, 'acme', 'rows', 'bad.json'), 'not json either')

    await expect(store.loadAll('acme')).rejects.toThrow()
  })

  it('a MISSING record is still null — the control', async () => {
    // Without this, "throw on everything" would satisfy both cases above and
    // break every first-read in hub.
    const store = toFile({ dir })
    expect(await store.get('acme', 'rows', 'nope')).toBeNull()
  })

  it('a MISSING collection is still an empty list, and a missing vault an empty snapshot', async () => {
    const store = toFile({ dir })
    expect(await store.list('acme', 'rows')).toEqual([])
    expect(await store.loadAll('acme')).toEqual({})
  })

  it('deleting what is already gone is still success', async () => {
    // The write-side twin's control: ENOENT on unlink is the caller's intent
    // already satisfied. Only a real failure (EACCES, EPERM) now propagates.
    const store = toFile({ dir })
    await expect(store.delete('acme', 'rows', 'never-existed')).resolves.toBeUndefined()
  })

  it('a round-trip still works end to end', async () => {
    const store = toFile({ dir })
    await store.put('acme', 'rows', 'r1', ENV)
    expect((await store.get('acme', 'rows', 'r1'))?._data).toBe('y')
    expect(await store.list('acme', 'rows')).toEqual(['r1'])
    await store.delete('acme', 'rows', 'r1')
    expect(await store.get('acme', 'rows', 'r1')).toBeNull()
  })
})
