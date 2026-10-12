/**
 * family#173 — store middleware must not drop a class store's prototype.
 *
 * ⛔ ALL SIX MIDDLEWARES WERE `{ ...next, get() {…} }`. A spread copies OWN
 * ENUMERABLE properties only, so wrapping a store implemented as a CLASS
 * dropped every prototype method the middleware did not itself redeclare —
 * `listPage`, `tx`, `getStoreTime`, `listSince`, `ping`, `presignUrl`,
 * `estimateUsage`. Hub reads those by `typeof store.x === 'function'` to decide
 * whether to delegate, so the capability silently became absent and hub took
 * its fallback path. Nothing failed; a paging store simply stopped paging.
 *
 * ⚠️ NO STORE IN core, to OR in IS CLASS-BASED TODAY, which is exactly why this
 * survived: every suite in this repo passes either way, and the bug lives in
 * the one consumer no test here can have. So the fixture below is a class
 * store — the shape the defect needs and the shape nothing in-tree provides.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  wrapStore, withRetry, withLogging, withMetrics, withCircuitBreaker, withCache, withHealthCheck,
} from '../src/with-store/store-middleware.js'
import type { EncryptedEnvelope, NoydbStore, VaultSnapshot, ListPageResult } from '../src/index.js'

const ENV: EncryptedEnvelope = { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'y' }

/** A class store: prototype methods, one `#private` field, optional extras. */
class ClassStore implements NoydbStore {
  readonly name = 'class-store'
  #records = new Map<string, EncryptedEnvelope>()
  #pages = 0

  async get(_v: string, _c: string, id: string): Promise<EncryptedEnvelope | null> {
    return this.#records.get(id) ?? null
  }
  async put(_v: string, _c: string, id: string, envelope: EncryptedEnvelope): Promise<void> {
    this.#records.set(id, envelope)
  }
  async delete(_v: string, _c: string, id: string): Promise<void> { this.#records.delete(id) }
  async list(): Promise<string[]> { return [...this.#records.keys()] }
  async loadAll(): Promise<VaultSnapshot> { return {} }
  async saveAll(): Promise<void> {}

  // ─── the optional surface a spread silently deleted ────────────────
  async ping(): Promise<boolean> { return true }
  async getStoreTime(): Promise<{ earliest: number; latest: number }> {
    return { earliest: 1, latest: 2 }
  }
  async listSince(): Promise<string[]> { return ['since'] }
  async listPage(): Promise<ListPageResult> {
    this.#pages += 1 // reads a #private field — throws if `this` is the proxy
    return { items: [], nextCursor: null }
  }
  pagesServed(): number { return this.#pages }
}

const MIDDLEWARES: ReadonlyArray<readonly [string, () => ReturnType<typeof withRetry>]> = [
  ['withRetry', () => withRetry({ maxRetries: 1, backoffMs: 1 })],
  ['withLogging', () => withLogging({ logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } })],
  ['withMetrics', () => withMetrics({ onOperation: () => {} })],
  ['withCircuitBreaker', () => withCircuitBreaker({})],
  ['withCache', () => withCache({ ttlMs: 1000 })],
  ['withHealthCheck', () => withHealthCheck({ checkIntervalMs: 1_000_000 })],
]

describe('family#173 — every middleware preserves a class store', () => {
  for (const [label, make] of MIDDLEWARES) {
    it(`${label} keeps the optional surface and the #private state`, async () => {
      const real = new ClassStore()
      const s = wrapStore(real, make())

      // 1. The contract methods still work through the wrapper.
      await s.put('v', 'c', 'r1', ENV)
      expect((await s.get('v', 'c', 'r1'))?._data).toBe('y')

      // 2. THE PROPERTY. Each of these was `undefined` under a spread, and hub
      //    would have concluded the store does not support it.
      for (const method of ['ping', 'getStoreTime', 'listSince', 'listPage'] as const) {
        expect(typeof s[method], `${label} dropped ${method}`).toBe('function')
      }

      // 3. A forwarded method reading a #private field — the `this`-binding
      //    half. With the proxy as receiver this throws a TypeError.
      await s.listPage!('v', 'c')
      expect((real as ClassStore).pagesServed()).toBe(1)

      // 4. The middleware's own rename still applies, so the overlay really is
      //    overriding and not merely forwarding everything.
      expect(s.name).not.toBe('class-store')
      expect(s.name).toContain('class-store')
    })
  }

  it('a method reference is stable, so a consumer can cache it', () => {
    // A fresh closure per access is observable. Not hypothetical: hub itself
    // reads `typeof store.listPage === 'function'` and then calls it, and a
    // consumer holding `const page = store.listPage` is ordinary JS.
    const s = wrapStore(new ClassStore(), withRetry({ maxRetries: 1 }))
    expect(s.listPage).toBe(s.listPage)
  })

  it('an override still wins over the wrapped store', async () => {
    // The control for all of the above: if the overlay forwarded everything,
    // every case here would pass while the middleware did nothing.
    // ⚠️ `withMetrics`, not `withLogging`. My first version passed a bare
    // function as `logger`, which `LoggingOptions` types as an OBJECT of four
    // level methods — so the option was silently ignored, nothing was recorded,
    // and the loop case above still passed. A control that can be satisfied by
    // a no-op is the thing this case exists to rule out.
    const ops: string[] = []
    const s = wrapStore(new ClassStore(), withMetrics({ onOperation: (op) => ops.push(op.method) }))
    await s.get('v', 'c', 'nope')
    expect(ops, 'withMetrics never intercepted get').toContain('get')
  })

  it('composes: two middlewares over a class store keep the surface', async () => {
    // Chained wrapping is where a spread's loss compounds — the inner wrapper
    // has already flattened the prototype before the outer one sees it.
    const s = wrapStore(new ClassStore(), withRetry({ maxRetries: 1 }), withCache({ ttlMs: 1000 }))
    expect(typeof s.getStoreTime).toBe('function')
    expect(typeof s.listPage).toBe('function')
    expect(await s.getStoreTime!()).toEqual({ earliest: 1, latest: 2 })
  })

  it('still works for an OBJECT-LITERAL store — the shape every in-tree store has', async () => {
    // The regression guard in the other direction. Every store in core, to and
    // in is a factory returning a literal; the fix must not change them.
    const literal: NoydbStore = {
      name: 'literal',
      async get() { return ENV },
      async put() {},
      async delete() {},
      async list() { return ['a'] },
      async loadAll() { return {} },
      async saveAll() {},
      async ping() { return true },
    }
    const s = wrapStore(literal, withRetry({ maxRetries: 1 }))
    expect((await s.get('v', 'c', 'x'))?._data).toBe('y')
    expect(typeof s.ping).toBe('function')
    expect(await s.ping!()).toBe(true)
  })
})
