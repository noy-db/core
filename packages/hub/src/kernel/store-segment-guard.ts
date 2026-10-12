/**
 * Hub's central segment check, as a decorator around the mounted store
 * (family#133's second half).
 *
 * ⭐ WHY IT IS CENTRAL. The segment rule is part of the store contract
 * ({@link NoydbStore}'s docstring), but until now every store enforced it
 * alone — so a malformed id reached whichever store the caller mounted and
 * nothing above it refused first. `to-file` paid for that: `join` COLLAPSES
 * `..` rather than refusing it, so `join(dir, vault, '..', id)` escapes the
 * VAULT while staying inside the store directory, and on a multi-tenant mount
 * the vault boundary is the one that matters. A store that happens to be
 * key-value rather than path-based has no such failure and therefore no reason
 * to have written the check — which is exactly why it belongs here.
 *
 * ⛔ THIS ENFORCES THE STATED CONTRACT, NOT A SUPERSET, and the difference is
 * not academic — the first version refused more and broke 60 of hub's own
 * tests. Two characters hub uses DELIBERATELY:
 *
 *  - `/` in an id. Persisted index side-cars are `_idx/<field>/<recordId>`,
 *    documented as slash-bearing on purpose.
 *  - `\x00` in an id. `resolveSequenceKey` and `resolvePeriodKey` join a
 *    partition as `${name}\x00${parts}` *because* a NUL cannot occur in a
 *    plain series name, so a partitioned key can never collide with an
 *    unpartitioned one. It is an in-band separator chosen for that property.
 *
 * So what is refused for an id is exactly what the contract states: an empty,
 * `.` or `..` COMPONENT. A store with stricter needs enforces its own — that is
 * what `to-file` does, and why its guard is not redundant.
 *
 * ⚠️ `vault` and `collection` are stricter, and that IS the contract: they are
 * single names, so a `/` or `\` in one is a separator wherever it lands.
 *
 * ⚠️ THIS IS NOT A REPLACEMENT FOR A STORE'S OWN GUARD, and `to-file`'s note
 * says so from its side: an out-of-tree caller can hold a `NoydbStore`
 * reference and never pass through hub. Defence in depth, both halves.
 * @module
 */
import { ValidationError } from './errors.js'
import type { NoydbStore, TxOp, VaultSnapshot } from './types.js'

/** `vault` and `collection` are single names: never empty, never `.`/`..`, no separator. */
function assertName(value: unknown, what: string): void {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new ValidationError(
      `store contract: ${what} must be a single segment — never empty, "." or "..", and carrying no `
      + `path separator or NUL. Got ${JSON.stringify(value)}.`,
    )
  }
}

/**
 * A record id MAY contain `/` and `\x00`; no slash-separated component may be
 * empty, `.` or `..`.
 *
 * ⛔ NO BACKSLASH OR NUL CHECK HERE, deliberately. Both were in the first
 * version, borrowed from `to-file`, and the NUL rule refused hub's own
 * partitioned sequence and period keys — 60 failing tests, every one of them
 * hub writing an id it had chosen `\x00` for on purpose. A central guard that
 * is stricter than the contract does not harden the system; it makes the
 * contract's own writers illegal.
 */
function assertId(id: unknown): void {
  if (typeof id !== 'string' || id === '') {
    throw new ValidationError(
      `store contract: record id must be a non-empty string. Got ${JSON.stringify(id)}.`,
    )
  }
  for (const part of id.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new ValidationError(
        `store contract: record id has an empty, "." or ".." component, which can escape its vault on a `
        + `path-based store. A slash IS allowed (hub writes "_idx/<field>/<id>"); an empty or `
        + `dot component is not. Got ${JSON.stringify(id)}.`,
      )
    }
  }
}

/**
 * The argument positions each guarded method needs checked.
 *
 * ⚠️ `saveAll` and `tx` are NOT positional — their segments live inside a
 * snapshot and an op list — so they are listed here as `custom` and handled
 * below. Writing them as positions would have validated the vault and silently
 * skipped every collection and id they carry, which is the half that matters.
 */
const POSITIONAL: Readonly<Record<string, 'v' | 'vc' | 'vci'>> = {
  loadAll: 'v',
  list: 'vc',
  listSince: 'vc',
  listPage: 'vc',
  get: 'vci',
  put: 'vci',
  delete: 'vci',
  presignUrl: 'vci',
}

function checkPositional(kind: 'v' | 'vc' | 'vci', args: readonly unknown[]): void {
  assertName(args[0], 'vault')
  if (kind === 'v') return
  assertName(args[1], 'collection')
  if (kind === 'vc') return
  assertId(args[2])
}

function checkSnapshot(args: readonly unknown[]): void {
  assertName(args[0], 'vault')
  const data = args[1] as VaultSnapshot | undefined
  for (const [collection, records] of Object.entries(data ?? {})) {
    assertName(collection, 'collection')
    for (const id of Object.keys(records ?? {})) assertId(id)
  }
}

function checkTx(args: readonly unknown[]): void {
  for (const op of (args[0] as readonly TxOp[] | undefined) ?? []) {
    assertName(op?.vault, 'vault')
    assertName(op?.collection, 'collection')
    assertId(op?.id)
  }
}

/**
 * Wrap `store` so every segment it is handed is checked first.
 *
 * ⛔ A PROXY, NOT `{ ...store, get() {…} }`, and the spread is a real defect
 * rather than a style preference: it copies OWN ENUMERABLE properties only, so
 * a store implemented as a CLASS loses every prototype method the wrapper does
 * not itself redeclare — `listPage`, `tx`, `getStoreTime`, `listSince`, `ping`
 * all vanish silently, and hub then takes its fallback paths as though the
 * store never offered them. (`with-store`'s `wrapStore` middleware still has
 * that shape; it is family#173, not fixed here.)
 *
 * ⚠️ `Reflect.apply(fn, target, args)` binds `this` to the TARGET, not the
 * proxy. That is load-bearing for a class store with `#private` fields: called
 * through the proxy as the receiver, a method touching `#field` throws
 * "Cannot read private member" — a failure that looks nothing like a wrapper
 * bug. Everything unguarded is forwarded the same way, so `name`,
 * `capabilities` and any vendor extension survive untouched.
 */
/**
 * The raw store behind a guard, or `store` itself if it is not guarded.
 *
 * ⚠️ Exists for `Noydb.store`, the published accessor whose whole purpose is
 * handing back what the caller mounted — `===` against their own argument. A
 * proxy satisfies every behavioural assertion and fails that one, which is how
 * `introspection/store-and-sync-targets.test.ts` found it.
 */
export function unguardedStore(store: NoydbStore): NoydbStore {
  return RAW.get(store) ?? store
}

/** guard proxy → the store it wraps. */
const RAW = new WeakMap<NoydbStore, NoydbStore>()

export function guardStoreSegments(store: NoydbStore): NoydbStore {
  const wrapped = new WeakMap<object, unknown>()
  const proxy: NoydbStore = new Proxy(store, {
    // ⚠️ `receiver` is deliberately not taken. Forwarding it would make `this`
    // the PROXY inside every method, which is the `#private`-field failure this
    // wrapper exists to avoid — `Reflect.get(target, prop, target)` and
    // `Reflect.apply(fn, target, …)` both pin the receiver to the real store.
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function' || typeof prop !== 'string') return value

      const check = prop === 'saveAll' ? checkSnapshot
        : prop === 'tx' ? checkTx
        : POSITIONAL[prop] !== undefined ? (args: readonly unknown[]) => checkPositional(POSITIONAL[prop]!, args)
        : null
      if (check === null) {
        // Forward with `this` bound to the target — see the note above.
        const cached = wrapped.get(value as object)
        if (cached !== undefined) return cached
        const passthrough = (...args: unknown[]): unknown => Reflect.apply(value as (...a: unknown[]) => unknown, target, args)
        wrapped.set(value as object, passthrough)
        return passthrough
      }

      const cached = wrapped.get(value as object)
      if (cached !== undefined) return cached
      // ⚠️ `async`, so a refusal REJECTS rather than throwing synchronously.
      // Every guarded method is declared `Promise<…>`, and a synchronous throw
      // from one is a contract violation a caller cannot catch the documented
      // way: `store.get(…).catch(…)` never sees it, and only `try`/`await`
      // does. Caught by this file's own cases, which were written with
      // `.rejects` against the declared type and failed against the
      // implementation.
      //
      // ⛔ Only the GUARDED methods become async. The passthrough above must
      // stay synchronous — `presenceSubscribe` returns an unsubscribe FUNCTION,
      // not a promise, and wrapping it in one would break every caller.
      const guarded = async (...args: unknown[]): Promise<unknown> => {
        check(args)
        return Reflect.apply(value as (...a: unknown[]) => unknown, target, args)
      }
      wrapped.set(value as object, guarded)
      return guarded
    },
  })
  RAW.set(proxy, store)
  return proxy
}
