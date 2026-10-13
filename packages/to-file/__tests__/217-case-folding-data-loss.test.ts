/**
 * family#217 — DATA LOSS on a case-folding filesystem, and a probe race that
 * disabled the guard meant to prevent it.
 *
 * Three defects, all measured against to-file@0.10.0-pre.2:
 *
 *   1. `saveAll` never ran `assertNoCaseCollision`, and THE PRUNE WAS THE
 *      KNIFE. `put('Abc')` then `saveAll({ c: { abc } })` wrote abc's body
 *      into the folded `Abc.json`, then the prune asked `'Abc' in records` —
 *      false, the snapshot says `abc` — and unlinked the file it had just
 *      written. `list` comes back EMPTY and `get('abc')` null. Both records
 *      gone, no error raised.
 *
 *   2. `put`'s check covered the LEAF only. `encodeId` maps `/` to `/`, so a
 *      side-car id like `_idx/<field>/<rec>` nests, and a folded DIRECTORY
 *      component collapses two ids one level above where the check looks.
 *
 *   3. The probe sentinel was a FIXED name. Two stores on one directory
 *      deleted each other's sentinel mid-probe and the loser cached
 *      "case-sensitive" for its whole lifetime — which turns the guard above
 *      off completely, so this one is load-bearing for the other two.
 *
 * ## Why these tests fake the filesystem
 *
 * The defects need a substrate that folds case. The machine this was written
 * on has one (APFS default) and CI does not (ubuntu/ext4), so a test against
 * the real filesystem would assert the property where it was already true and
 * pass VACUOUSLY in the only place that gates a merge. The double below folds
 * deterministically on either host, and case 0 refuses to let the rest of the
 * file run unless it is actually folding.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm as realRm, readdir as realReaddir, writeFile as realWriteFile, readFile as realReadFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { EncryptedEnvelope } from '@noy-db/hub'

/** Paths under this root are case-folded by the double. Set per test. */
let foldRoot: string | null = null

/** Armed by the race test: pause the next `stat` whose path matches. */
let statGate: { match: RegExp; reached: () => void; release: Promise<void> } | null = null

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

  /**
   * Resolve `p` the way a case-folding filesystem would: component by
   * component, an incoming name that differs from an existing sibling only by
   * case RESOLVES TO THAT SIBLING. A name with no case-insensitive match is
   * left alone, which is how a genuinely new file keeps the case it was
   * created with.
   */
  async function fold(p: unknown): Promise<unknown> {
    if (typeof p !== 'string' || foldRoot === null || !p.startsWith(foldRoot)) return p
    const rest = p.slice(foldRoot.length).split(sep).filter(Boolean)
    let current = foldRoot
    for (const part of rest) {
      let entries: string[] = []
      try {
        entries = await actual.readdir(current)
      } catch {
        // Nothing resolved below a path that does not exist — keep the
        // remainder verbatim.
        return join(current, ...rest.slice(rest.indexOf(part)))
      }
      const exact = entries.includes(part)
      const match = exact ? part : entries.find((e) => e.toLowerCase() === part.toLowerCase())
      current = join(current, match ?? part)
    }
    return current
  }

  type AnyFsFn = (...args: unknown[]) => unknown

  /**
   * Wrap one `node:fs/promises` function so its leading `pathCount` arguments
   * are folded first. Every path-taking call to-file makes has to go through
   * this, not just the file writes: the case PROBE is `mkdir` + `stat`, so a
   * double that folded only reads and writes would leave `filesystemFoldsCase`
   * answering `false` and every assertion below passing vacuously.
   */
  const folding = (fn: unknown, pathCount: number): AnyFsFn =>
    async (...args: unknown[]) => {
      const next = [...args]
      for (let k = 0; k < pathCount; k += 1) next[k] = await fold(next[k])
      return (fn as AnyFsFn)(...next)
    }

  return {
    ...actual,
    readFile: folding(actual.readFile, 1),
    writeFile: folding(actual.writeFile, 1),
    readdir: folding(actual.readdir, 1),
    mkdir: folding(actual.mkdir, 1),
    unlink: folding(actual.unlink, 1),
    rm: folding(actual.rm, 1),
    // `rename` is atomic-write's commit step: BOTH sides fold, or the tmp file
    // lands beside the folded target instead of replacing it.
    rename: folding(actual.rename, 2),
    stat: (async (...args: unknown[]) => {
      const p = args[0]
      if (statGate !== null && typeof p === 'string' && statGate.match.test(p)) {
        const gate = statGate
        statGate = null
        gate.reached()
        await gate.release
      }
      return folding(actual.stat, 1)(...args)
    }) as AnyFsFn,
  }
})

const { toFile } = await import('../src/index.js')

function makeEnvelope(v: number, data: string): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: '2026-10-14T00:00:00Z', _iv: 'iv', _data: data }
}

describe('family#217 — a case-folding filesystem must not eat records', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-f217-'))
    foldRoot = dir
    statGate = null
  })

  afterEach(async () => {
    foldRoot = null
    statGate = null
    await realRm(dir, { recursive: true, force: true })
  })

  it('0. PRECONDITION: the double actually folds case', async () => {
    // ⛔ Without this, every case below passes on a case-SENSITIVE host for the
    // one reason that proves nothing: no collision ever happened. This is the
    // assertion that makes the rest of the file mean something in CI.
    await realWriteFile(join(dir, 'Abc.json'), 'UPPER')
    const { writeFile, readdir, readFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'abc.json'), 'lower')
    expect(await readdir(dir), 'the double did not fold: two files survived').toEqual(['Abc.json'])
    expect(await readFile(join(dir, 'Abc.json'), 'utf8')).toBe('lower')
    expect(await realReadFile(join(dir, 'Abc.json'), 'utf8'), 'the write did not land on disk').toBe('lower')
  })

  it('1. THE DATA LOSS: saveAll must not write into a folded record and then prune it', async () => {
    const store = toFile({ dir })
    const abcUpper = makeEnvelope(1, 'UPPER-Abc')
    await store.put('v1', 'c', 'Abc', abcUpper)

    // ⚠️ THE ORDER OF THESE ASSERTIONS IS THE POINT, and the first draft had it
    // backwards. Leading with `rejects.toThrow` short-circuits on the pre-fix
    // code at "promise resolved instead of rejecting" — which proves the guard
    // is missing but never witnesses the DATA LOSS the row is about. Capturing
    // the outcome and asserting survival FIRST makes the pre-fix failure read
    // `list` = [] against ['Abc'], which is the reported symptom itself.
    //
    // ⭐ It is also the more durable contract. Per `@noy-db/ports`' own
    // case-folding case, a store may either REFUSE or represent both ids; what
    // is forbidden is accepting the write and keeping neither. Asserting "no
    // record was lost" first holds for either resolution; asserting the throw
    // first would fail a future store that legitimately represented both.
    const outcome = await store
      .saveAll('v1', { c: { abc: makeEnvelope(1, 'lower-abc') } })
      .then(() => 'resolved' as const, (err: unknown) => err)

    expect(await store.list('v1', 'c'), 'the record was PRUNED after the fold — this is the data loss').toEqual(['Abc'])
    expect(await store.get('v1', 'c', 'Abc'), "the existing record's body was replaced by the folded write").toEqual(abcUpper)

    // Having kept the data, the store must also have reported that it could
    // not apply the snapshot, rather than silently ignoring half of it.
    expect(outcome, 'saveAll accepted a snapshot it cannot represent').toBeInstanceOf(Error)
    expect(String(outcome)).toMatch(/case-folds/)
  })

  it('2. a refused saveAll writes NOTHING — the refusal is total, not torn', async () => {
    // The guard asserts the whole snapshot before writing any of it. Checking
    // inside the write loop would refuse correctly and leave a half-applied
    // restore behind, which is worse than the torn-write case the method's
    // ordering already accepts: that one is re-runnable, this one reports
    // failure while having changed the store.
    const store = toFile({ dir })
    await store.put('v1', 'c', 'Abc', makeEnvelope(1, 'UPPER-Abc'))

    await expect(
      store.saveAll('v1', {
        other: { safe: makeEnvelope(1, 'safe-body') },
        c: { abc: makeEnvelope(1, 'lower-abc') },
      }),
    ).rejects.toThrow(/case-folds/)

    expect(
      await store.list('v1', 'other'),
      'a refused restore still wrote part of the snapshot',
    ).toEqual([])
  })

  it('3. a folded DIRECTORY component is refused, not only a folded leaf', async () => {
    // `encodeId` preserves `/`, so this nests. The leaf check could never fire
    // here: at the leaf (`x.json` vs `x.json`) there is nothing wrong — the
    // collapse is one level up, where `a/` resolves onto `A/`.
    const store = toFile({ dir })
    const kept = makeEnvelope(1, 'UPPER-dir')
    await store.put('v1', 'c', 'A/x', kept)

    // Survival first, for the same reason as case 1: on the pre-fix code this
    // fails on the BODY having been replaced, which is the collapse, rather
    // than on a missing throw.
    const outcome = await store
      .put('v1', 'c', 'a/x', makeEnvelope(1, 'lower-dir'))
      .then(() => 'resolved' as const, (err: unknown) => err)

    expect(await store.get('v1', 'c', 'A/x'), "the first id's body was replaced through a folded directory").toEqual(kept)
    expect(outcome, 'a folded directory component collapsed two ids silently').toBeInstanceOf(Error)
    expect(String(outcome)).toMatch(/case-folds/)
  })

  it('4. the directory refusal names the directory, so the reader does not hunt for a record', async () => {
    const store = toFile({ dir })
    await store.put('v1', 'c', 'A/x', makeEnvelope(1, 'UPPER-dir'))
    await expect(store.put('v1', 'c', 'a/x', makeEnvelope(1, 'lower'))).rejects.toThrow(
      /\(a directory component\)/,
    )
  })

  it('5. THE PROBE RACE: a second store must not switch the guard off', async () => {
    // ⛔ The sentinel was a FIXED name, and `mkdir(…, { recursive: true })`
    // succeeds on a directory that already exists — so store B's probe
    // adopted A's sentinel and B's cleanup deleted it. Landing that between
    // A's mkdir and A's stat makes A conclude case-SENSITIVE and cache it
    // forever, turning off every guard above for A's whole lifetime.
    //
    // ⚠️ The interleaving is FORCED, not hoped for. Gating A's probe stat and
    // running B's entire probe inside the gap is what makes this a test rather
    // than a race the scheduler usually wins.
    let release!: () => void
    const released = new Promise<void>((r) => { release = () => r() })
    const reachedProbe = new Promise<void>((r) => {
      statGate = { match: /case-probe/, reached: r, release: released }
    })

    const storeA = toFile({ dir })
    // Triggers A's probe (no collision — `Abc` is the first write).
    const aWrite = storeA.put('v1', 'c', 'Abc', makeEnvelope(1, 'UPPER-Abc'))
    await reachedProbe

    // B's WHOLE probe runs in the gap, cleanup included.
    const storeB = toFile({ dir })
    await storeB.put('v1', 'other', 'Zzz', makeEnvelope(1, 'z'))

    release()
    await aWrite

    // A must still know the filesystem folds. Pre-fix it had cached `false`
    // and this put SUCCEEDED, collapsing `abc` onto `Abc`.
    await expect(
      storeA.put('v1', 'c', 'abc', makeEnvelope(1, 'lower-abc')),
      "store A's probe was sabotaged by store B and the guard went silent",
    ).rejects.toThrow(/case-folds/)
  })

  it('6. CONTROL: a non-colliding saveAll still replaces and prunes', async () => {
    // The guard must not turn `saveAll` into a blanket refusal — without this,
    // every case above would also pass if the method simply always threw.
    const store = toFile({ dir })
    await store.put('v1', 'c', 'keep', makeEnvelope(1, 'old-keep'))
    await store.put('v1', 'c', 'drop', makeEnvelope(1, 'old-drop'))

    const fresh = makeEnvelope(2, 'new-keep')
    await store.saveAll('v1', { c: { keep: fresh } })

    expect(await store.list('v1', 'c')).toEqual(['keep'])
    expect(await store.get('v1', 'c', 'keep')).toEqual(fresh)
    expect(await store.get('v1', 'c', 'drop')).toBeNull()
  })

  it('7. CONTROL: ids differing by more than case are untouched by any of this', async () => {
    const store = toFile({ dir })
    const a = makeEnvelope(1, 'a-body')
    const b = makeEnvelope(1, 'b-body')
    await store.put('v1', 'c', 'Abc', a)
    await store.put('v1', 'c', 'Xyz', b)
    await store.saveAll('v1', { c: { Abc: a, Xyz: b } })
    expect((await store.list('v1', 'c')).sort()).toEqual(['Abc', 'Xyz'])
  })
})
