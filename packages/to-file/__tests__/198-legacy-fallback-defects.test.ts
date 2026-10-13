/**
 * core#198's legacy fallback was wrong in four ways. `to` found them reading my
 * code; every one reproduced at the line before being fixed.
 *
 * ⛔ (i) IS A CROSS-ID READ, and my own changeset understated it as a cosmetic
 * `list` artefact. `a%00b` is simultaneously a literal id AND the encoded form
 * of `a\x00b`, so falling back to the raw `a%00b.json` for the literal id
 * handed back the NUL id's record. Measured: `get('a%00b')` returned the body
 * written for `a\x00b`.
 *
 * ⛔ (iii) IS WORSE THAN "PARTIAL". The throw happened inside `loadAll`'s own
 * `try`, which abandoned the whole collection — a vault holding one NUL-bearing
 * id and one ordinary record returned an EMPTY snapshot. A sync peer reads that
 * as every record deleted.
 *
 * ⚠️ The fallback is a MIGRATION, not a second permanent lookup path: a write
 * drops the raw copy, so a record converges on one file. That is also what stops
 * (iv) — a delete that left the legacy copy standing, so `list` resurfaced it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toFile } from '../src/index.js'
import type { EncryptedEnvelope } from '@noy-db/hub'

const E = (v: number, d: string): EncryptedEnvelope => ({ _noydb: 1, _v: v, _ts: 't', _iv: 'x', _data: d })

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nf198-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** Write a pre-encoding file by hand — exactly what an older to-file left. */
async function legacyFile(collection: string, name: string, env: EncryptedEnvelope): Promise<void> {
  await mkdir(join(dir, 'v', collection), { recursive: true })
  await writeFile(join(dir, 'v', collection, `${name}.json`), JSON.stringify(env))
}

describe('core#198 (i) — the fallback must not read another id', () => {
  it('⛔ get("a%00b") does NOT return the record stored for "a\\0b"', async () => {
    const s = toFile({ dir })
    await s.put('v', 'c', 'a\u0000b', E(1, 'NUL-RECORD'))
    expect(
      await s.get('v', 'c', 'a%00b'),
      'the legacy fallback served a different id\'s ciphertext',
    ).toBeNull()
  })

  it('and the NUL id itself still reads back — the control', async () => {
    // Without this, a guard that disabled the fallback entirely would pass the
    // case above while breaking what family#174 was for.
    const s = toFile({ dir })
    await s.put('v', 'c', 'a\u0000b', E(1, 'NUL-RECORD'))
    expect((await s.get('v', 'c', 'a\u0000b'))?._data).toBe('NUL-RECORD')
  })

  it('a genuine legacy %-id still reads — the other control', async () => {
    // `a%3Ab` is not a valid encoded form (`%3A` is neither `%25` nor `%00`),
    // so the raw file can only be its own legacy copy.
    const s = toFile({ dir })
    await legacyFile('c', 'a%3Ab', E(3, 'legacy'))
    expect((await s.get('v', 'c', 'a%3Ab'))?._data).toBe('legacy')
  })
})

describe('core#198 (ii) — the CAS must see the legacy version', () => {
  it('⛔ a versioned put against a legacy %-id does not conflict forever', async () => {
    const s = toFile({ dir })
    await legacyFile('c', 'a%3Ab', E(3, 'legacy'))
    expect((await s.get('v', 'c', 'a%3Ab'))?._v, 'the fixture is not a legacy record').toBe(3)

    await expect(s.put('v', 'c', 'a%3Ab', E(4, 'next'), 3)).resolves.toBeUndefined()
    expect((await s.get('v', 'c', 'a%3Ab'))?._data).toBe('next')
  })

  it('and a WRONG expectation still conflicts — the control', async () => {
    // A CAS that read the legacy version and then ignored it would pass the
    // case above. The comparison still has to bite.
    const s = toFile({ dir })
    await legacyFile('c', 'a%3Ab', E(3, 'legacy'))
    await expect(s.put('v', 'c', 'a%3Ab', E(4, 'next'), 1)).rejects.toThrow(/expected 1, found 3/)
  })
})

describe('core#198 (iii) — loadAll must not abandon a collection', () => {
  it('⛔ a NUL-bearing id does not empty the whole snapshot', async () => {
    const s = toFile({ dir })
    await s.put('v', 'c', 'a\u0000b', E(1, 'nul'))
    await s.put('v', 'c', 'plain', E(1, 'plain'))

    const snap = await s.loadAll('v')
    expect(Object.keys(snap.c ?? {}).sort()).toEqual(['a\u0000b', 'plain'])
    expect(snap.c?.['a\u0000b']?._data).toBe('nul')
  })

  it('and a legacy %-id appears in the snapshot too', async () => {
    const s = toFile({ dir })
    await legacyFile('c', 'a%3Ab', E(1, 'legacy'))
    const snap = await s.loadAll('v')
    expect(snap.c?.['a%3Ab']?._data).toBe('legacy')
  })
})

describe('core#198 (iv) — a delete must remove both names', () => {
  it('⛔ a deleted legacy record does not resurface on list', async () => {
    const s = toFile({ dir })
    await legacyFile('c', 'a%3Ab', E(1, 'legacy'))
    await s.delete('v', 'c', 'a%3Ab')

    expect(await readdir(join(dir, 'v', 'c'))).toEqual([])
    expect(await s.list('v', 'c')).toEqual([])
    expect(await s.get('v', 'c', 'a%3Ab')).toBeNull()
  })

  it('⭐ a WRITE drops the raw copy, so the record converges on one file', async () => {
    // The fallback is a migration, not a permanent second lookup path. Leaving
    // both files meant `list` reported the record twice — under its real name
    // and under the decoded legacy one.
    const s = toFile({ dir })
    await legacyFile('c', 'a%3Ab', E(1, 'legacy'))
    await s.put('v', 'c', 'a%3Ab', E(2, 'rewritten'))

    expect(await readdir(join(dir, 'v', 'c'))).toEqual(['a%253Ab.json'])
    expect(await s.list('v', 'c')).toEqual(['a%3Ab'])
    expect((await s.get('v', 'c', 'a%3Ab'))?._data).toBe('rewritten')
  })
})
