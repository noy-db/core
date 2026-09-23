/**
 * core#54, fourth instance — every type in a PUBLIC KERNEL METHOD's signature
 * must be nameable from the root barrel.
 *
 * `Noydb` / `Vault` / `Collection` are exported, so their methods are
 * callable. That is not the same as usable: a consumer who can call
 * `v.restoreTo(ts, { dryRun: true })` with an object literal but cannot write
 * `RestoreToOptions` has no way to hold the argument in a variable, wrap the
 * call, or type a helper's return.
 *
 * ⛔ THIS IS THE FOURTH TIME THE SAME PARTIAL SHAPE SHIPPED IN ONE DAY —
 * `StoreAuth`/`Unsubscribe`, then `KeyringInboxBox`, then `RestoreToOptions`,
 * `RestoreToResult`, `LoadPodOptions` and `LoadPodResult`. The last of those
 * was found by the coordination layer measuring the published tarball AFTER a
 * dev cut, against a claim of mine that the four were on the barrel — a claim
 * I had not actually grepped.
 *
 * ⭐ `__tests__/54-ports-bindable-alone.test.ts` exists for the same defect
 * class and could not catch these: it measures PORT SUBPATHS (`/on`, `/to`,
 * `/as`) being bindable alone, and these four are kernel-method types on the
 * ROOT BARREL. Same shape, different surface — which is exactly why a fifth
 * instance was coming.
 *
 * ## How this reads the surface
 *
 * ⚠️ AGAINST EVERY PUBLISHED ENTRY POINT, not just the root barrel — and that
 * correction halved the finding. The first version of this check asked only
 * "is it on `src/index.ts`", which over-reported by 13 of 20: a consumer who
 * imports `@noy-db/hub/periods` can name `PeriodScope` perfectly well, and
 * `TierMoveResult` lives on `/tiers`, `CompactionResult` on `/blobs`,
 * `RevocationList` on `/attestation`. A type is NAMEABLE if any published
 * subpath names it; demanding the root barrel specifically is a different and
 * stricter rule than the one this test claims to enforce.
 *
 * ⭐ The predicate has to match the property, and mine did not — the same
 * defect this file exists to catch, one level up. The entry points are read
 * from `package.json`'s `exports` map (the consumer's own view) and mapped
 * back to `src`, so it still runs without a build.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(HUB, 'src')

/** Every published entry point's declarations, read through the exports map. */
const entryPoints: string[] = (() => {
  const exp = JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')).exports as Record<string, unknown>
  const out: string[] = []
  for (const v of Object.values(exp)) {
    const types = typeof v === 'object' && v !== null ? (v as { types?: string }).types : undefined
    if (!types) continue
    const src = join(HUB, types.replace('./dist/', 'src/').replace(/\.d\.ts$/, '.ts'))
    if (existsSync(src)) out.push(readFileSync(src, 'utf8'))
  }
  return out
})()

/** Nameable if ANY published entry point names it. */
const nameable = (n: string): boolean => {
  const re = new RegExp(`\\b${n}\\b`)
  return entryPoints.some(src => re.test(src))
}

/**
 * Types deliberately not on the root barrel. Each needs a REASON — not a
 * name. A bare list is a list nobody can audit.
 */
const ALLOWED_UNEXPORTED = new Map<string, string>([
  ['Vault', 'the class itself, exported as a value not a type alias'],
  ['Collection', 'as above'],
  ['Noydb', 'as above'],
  ['VaultInstant', 'exported from the root barrel as a value (the class)'],
  ['CollectionInstant', 'as above'],
  ['VaultFrame', 'shadow-view class, exported as a value'],
  ['RestoreToHost', 'the port contract between vault and the restore engine — internal seam, deliberately unpublished (core#76)'],
])

/**
 * ⛔ RATCHET, NOT AN ALLOWLIST — these are the instances that already existed
 * when this check was written (core#126). They are NOT blessed: each is a
 * consumer who can call a method and cannot name its argument or its result.
 * `DelegationToken` and `IssueDelegationOptions` are the clearest — the whole
 * core#65 delegation API, callable and unnameable.
 *
 * ⭐ The rule is the one `subtle-outside-capsule` established here: the list
 * may SHRINK and must never grow. A new entry means the check stopped doing
 * its job; fix the export instead. Burn-down tracked on core#126.
 */
const PRE_EXISTING = new Set<string>([])

/** Identifiers that are TypeScript built-ins or structural noise, never hub types. */
const BUILTIN = new Set([
  'Promise', 'Array', 'ReadonlyArray', 'Readonly', 'Record', 'Partial', 'Map', 'Set', 'Date',
  'string', 'number', 'boolean', 'void', 'unknown', 'never', 'null', 'undefined', 'object', 'any',
  'T', 'K', 'V', 'P', 'R', 'U', 'AsyncIterable', 'Iterable', 'Uint8Array', 'Error', 'RegExp',
  'Omit', 'Pick', 'Exclude', 'Extract', 'NonNullable', 'Awaited', 'this', 'Function', 'Blob', 'File',
  'Float32Array', 'ArrayBuffer', 'Object', 'Symbol', 'WeakMap',
  // single-letter and short generic parameters declared on the method itself
  'M', 'Q', 'Keys', 'Out',
])

/** Public method signatures: `  async name(...): Ret {` / `  name(...): Ret {` */
function publicSignatures(source: string): string[] {
  const out: string[] = []
  for (const line of source.split('\n')) {
    const m = /^ {2}(?:async )?([a-zA-Z][\w]*)\s*(?:<[^>]*>)?\s*\(/.exec(line)
    if (!m || BUILTIN.has(m[1]!)) continue
    if (m[1]!.startsWith('_') || m[1] === 'constructor') continue
    out.push(line)
  }
  return out
}

const typeNames = (sig: string): string[] =>
  [...sig.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)].map(m => m[1]!).filter(n => !BUILTIN.has(n))

describe('core#54 — a public kernel method\'s types are nameable from the root barrel', () => {
  it.each(['kernel/noydb.ts', 'kernel/vault.ts', 'kernel/collection.ts'])('%s', (rel) => {
    const source = readFileSync(join(SRC, rel), 'utf8')
    const missing = new Set<string>()
    for (const sig of publicSignatures(source)) {
      for (const name of typeNames(sig)) {
        if (ALLOWED_UNEXPORTED.has(name) || PRE_EXISTING.has(name)) continue
        if (nameable(name)) continue
        missing.add(name)
      }
    }
    expect([...missing].sort(), `${rel}: named in a public method signature and nameable from NO ` +
      `published entry point. Export it from the subpath that owns it (or the root barrel), or ` +
      `add it to ALLOWED_UNEXPORTED with a reason.`).toEqual([])
  })
})
