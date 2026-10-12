/**
 * family#165 — a failing transaction rejected a promise nobody was listening to.
 *
 * ⛔ WHY IT MATTERED MORE THAN A NOISY LOG. `tx()` hands back a `complete`
 * promise that rejects on `transaction.onerror`, and every READ path
 * destructured only `{ store }`. So a transaction that failed produced an
 * `unhandledrejection` event in a browser and a process-level warning in
 * Node — or a process EXIT under `--unhandled-rejections=strict`, which is the
 * default for a Node test runner. A store-level read error could take down the
 * host application, from a path the caller was already awaiting an error from.
 *
 * ⚠️ TWO PROPERTIES, and a fix can satisfy one while breaking the other:
 *   1. no unhandled rejection, and
 *   2. the error still REACHES the caller.
 * Swallowing `complete` would give (1) and lose (2) — a read that silently
 * returned a partial result on a failed transaction, which is strictly worse
 * than a crash. `tx()` marks the promise handled with `p.catch(() => {})`,
 * which returns a NEW promise and leaves the original rejecting for anyone who
 * awaits it, so both hold.
 *
 * ⛔ THE BEHAVIOURAL PROPERTY IS NOT REACHABLE WITH `fake-indexeddb`, and
 * saying so is the honest state of this file. Firing `transaction.onerror`
 * needs a request that fails inside an open transaction, and a key-value store
 * with no indexes and no constraints offers no way to cause one — closing the
 * connection makes `db.transaction()` throw SYNCHRONOUSLY instead, which
 * rejects `tx()` itself and is already handled by the awaiting caller.
 *
 * So the load-bearing case here is STRUCTURAL: every `tx()` call site must
 * destructure `complete`. It is the one that fails without the fix. The two
 * round-trip cases are controls for the FIX rather than for the bug — awaiting
 * a readonly transaction's completion could have deadlocked, and that is a real
 * risk of this change — and they are labelled as such rather than counted as
 * coverage they do not provide.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { toBrowserIdb } from '../src/index.js'

let counter = 0

/** Collect unhandled rejections for the duration of one case. */
function watchUnhandled(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown): void => { seen.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  return { seen, stop: () => { process.off('unhandledRejection', onUnhandled) } }
}

/** Let the microtask queue AND one macrotask turn drain, so a would-be
 *  unhandled rejection has actually been reported by the time we assert. */
const settle = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 10)) }

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
})
afterEach(() => {
  ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
})

describe('family#165 — a failing transaction does not reject into nothing', () => {
  it('⭐ every transaction-opening method consumes its `complete`', async () => {
    // THE LOAD-BEARING CASE, and the only one that fails without the fix. The
    // defect was a call site that took `{ store }` alone, so a new method added
    // that way would reintroduce it silently — and no behavioural case here can
    // see it, for the reason in the file header.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    const sites = src.match(/const \{[^}]*\} = await tx\(/g) ?? []
    expect(sites.length, 'no tx() call sites found — the regex drifted').toBeGreaterThan(5)
    for (const site of sites) {
      expect(site, `a tx() site ignores complete: ${site}`).toContain('complete')
    }
    // And `tx` itself marks the promise handled, for any path that still does
    // not — belt and braces, because the regex above protects a convention and
    // this protects the mechanism.
    expect(src).toMatch(/complete\.catch\(\(\) => \{\}\)/)
  })

  it('control for the FIX: the normal read path still completes, it does not hang', async () => {
    // ⚠️ Not a control for the bug. `await complete` on a READONLY transaction
    // is new, and a transaction whose `oncomplete` never fires would deadlock
    // every read in the adapter. This is what rules that out.
    const store = toBrowserIdb({ prefix: `t165-${++counter}` })
    await store.put('v', 'c', 'r1', { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'y' })
    expect((await store.get('v', 'c', 'r1'))?._data).toBe('y')
    expect(await store.list('v', 'c')).toEqual(['r1'])
    expect(await store.loadAll('v')).toHaveProperty('c')
    expect((await store.listPage!('v', 'c'))?.items.map((i) => i.id)).toEqual(['r1'])
    await store.delete('v', 'c', 'r1')
    expect(await store.get('v', 'c', 'r1')).toBeNull()
  })

  it('⭐ the cached connection is invalidated on close and on versionchange', async () => {
    // The second half of family#165. `dbPromise` cached one connection for the
    // adapter's lifetime, so once it went away every later transaction failed
    // against a dead handle — permanently, because nothing cleared the cache.
    // A connection goes away for ordinary reasons: another tab runs a
    // `versionchange`, the browser evicts the origin under storage pressure,
    // the user clears site data. The adapter needed a page reload.
    //
    // ⛔ ASSERTED STRUCTURALLY, and the reason is the same as for `complete`:
    // the handle is private to the closure, so a test cannot reach it to close
    // it, and `fake-indexeddb` fires neither event on its own. A behavioural
    // case here passed with the fix STASHED — it was measuring nothing, and
    // three green cases that include one of those is worse than two honest
    // ones, because the count reads as coverage.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(src, 'nothing clears the cached connection when it closes').toMatch(/db\.onclose\s*=/)
    expect(src, 'a versionchange in another tab would block on this connection')
      .toMatch(/db\.onversionchange\s*=/)
    // And the invalidation is a CLEAR, not a log: the next call must reopen.
    expect(src).toMatch(/dbPromise = null/)
  })

  it('⭐ a REJECTED open is not cached — one transient failure is not permanent', async () => {
    // The worse half of the same cache. A failure at startup — storage not yet
    // granted, a private-mode quirk — used to be replayed for every call for
    // the rest of the session.
    const broken = { open: () => { throw new Error('storage unavailable') } }
    const real = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB
    ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = broken

    const store = toBrowserIdb({ prefix: `t165-${++counter}` })
    await expect(store.get('v', 'c', 'r1')).rejects.toThrow(/storage unavailable/)

    // Storage comes back. The adapter must retry rather than replay.
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = real
    await store.put('v', 'c', 'r1', { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'y' })
    expect((await store.get('v', 'c', 'r1'))?._data, 'a transient open failure was cached forever').toBe('y')
  })

  it('control for the FIX: no unhandled rejection on the ordinary path either', async () => {
    // Weak by construction — the fake cannot fail a transaction — but it does
    // rule out the fix ITSELF introducing one, which `p.catch()` placement
    // could plausibly get wrong.
    const store = toBrowserIdb({ prefix: `t165-${++counter}` })
    const watch = watchUnhandled()
    await store.put('v', 'c', 'r1', { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'y' })
    await Promise.all(Array.from({ length: 20 }, () => store.get('v', 'c', 'r1')))
    await settle()
    watch.stop()
    expect(watch.seen, `unhandled rejection(s): ${watch.seen.map(String).join(', ')}`).toEqual([])
  })
})
