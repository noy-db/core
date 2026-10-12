/**
 * Which hub features need which capsule group, and the two refusal points
 * (family#156).
 *
 * ⛔ AT STARTUP OR NOT AT ALL. A capability discovered on first write is a
 * half-built vault: some records sealed, a service silently inert, and a
 * consumer who cannot tell a missing capability from a bug. So this refuses at
 * `createNoydb()` for a SERVICE, and at `vault.collection()` for a declared
 * FIELD — the two places a requirement becomes known.
 *
 * ⭐ TWO POINTS, BECAUSE A DECLARATION IS NOT A STRATEGY. A `classifiedFields`
 * declaration writes `_vdig`/`_sealed` with no `classifiedStrategy` at all: the
 * strategy is the READ side (reveal/verify/matchGroup), while the codec's
 * `vdigFields` map comes straight from the declaration at construction.
 * Measured before wiring — a single check at `createNoydb()` would have left
 * every write-side requirement unenforced while looking complete.
 *
 * ⚠️ `authenticate` and `seal` ARE DELIBERATELY ABSENT from both tables, and
 * that is a measurement, not an omission. `deriveKey` (secret → KEK) and
 * `wrapKey`/`unwrapKey` (KEK wraps DEK) are called only from the keyring unlock
 * chain — `with-party/team/keyring.ts` and the DEK-rewrapping paths in
 * `with-cargo`/`custody`/`delegation` — never from a field form. Mapping
 * `storage:'recoverable'` to `seal` or `digest-only` to `authenticate` would
 * have been plausible and invented: those two are the POSTURE groups
 * (`PRIMITIVE_GROUPS` has no primitive for either), and what actually implies
 * them is opening a vault with a secret. That is a THIRD refusal point this
 * ruling did not name, so it is reported rather than added here.
 * @module
 */
import { assertCapsuleSupports, type CapsuleGroup } from '../capsule/contract.js'

/**
 * Service option → group, for the groups a service cannot work without.
 *
 * Derived from the call sites, not from the service's description: `wrapCek` /
 * `unwrapCek` outside `capsule/` appear in exactly `with-shape/blobs`,
 * `with-cargo` and `with-audit/tiers`.
 *
 * ⚠️ `perRecordKeys` is NOT here — it is a COLLECTION option, so it belongs to
 * the field table below. It needs the same group as these three and is reached
 * without any of them, which a service-only check would have missed.
 */
// ⚠️ NOT exported — `serviceGroupRequirements()` is the only reader, and knip
// is right that a second way in is dead. The table is asserted through that
// function, which is also what the call site uses, so the test and production
// take the same path.
const SERVICE_GROUPS: ReadonlyArray<readonly [string, CapsuleGroup]> = [
  ['blobsStrategy', 'per-record-keys'],
  ['cargoStrategy', 'per-record-keys'],
  ['tiersStrategy', 'per-record-keys'],
  ['classifiedStrategy', 'classify'],
]

/** The declaration shape the field check reads — a slice of the collection options. */
export interface DeclaredFieldGroups {
  readonly sensitiveFields?: ReadonlySet<string> | readonly string[] | null
  readonly deterministicFields?: ReadonlySet<string> | readonly string[] | null
  readonly perRecordKeys?: boolean
  /** Classified members by field, with the storage form that decides the group. */
  readonly classifiedByField?: Readonly<Record<string, { readonly storage: string; readonly equatable?: boolean }>> | null
}

const some = (v: ReadonlySet<string> | readonly string[] | null | undefined): boolean => {
  if (v == null) return false
  // ⚠️ Both shapes, because the two options differ: `deterministicFields` is a
  // declared array and `sensitiveFields` is frozen into a Set at construction.
  // A `length > 0` check alone reads `undefined` on the Set and silently
  // concludes "no fields declared" — the refusal would never fire for the one
  // of the two that is more likely to carry a secret.
  return Array.isArray(v) ? v.length > 0 : (v as ReadonlySet<string>).size > 0
}

/**
 * Every (group, requirer) a set of declared fields needs — the pure half.
 *
 * ⭐ SEPARATED FROM THE THROW on purpose (the family#172 lesson applied to this
 * wiring): the reference capsule supports every group, so no integration test
 * can reach a refusal, and a predicate that only ever runs against a capsule
 * which never refuses is exactly the shape family#172 had to fix. The decision
 * is testable against a stub set; what still needs its own test is that
 * anything CALLS it.
 */
export function fieldGroupRequirements(
  collection: string,
  decl: DeclaredFieldGroups,
): ReadonlyArray<readonly [CapsuleGroup, string]> {
  const out: Array<readonly [CapsuleGroup, string]> = []
  if (some(decl.sensitiveFields)) out.push(['sealing', `collection "${collection}" sensitiveFields`])
  if (some(decl.deterministicFields)) out.push(['deterministic', `collection "${collection}" deterministicFields`])
  if (decl.perRecordKeys === true) out.push(['per-record-keys', `collection "${collection}" perRecordKeys`])
  for (const [field, spec] of Object.entries(decl.classifiedByField ?? {})) {
    // `never` stores nothing, so it needs nothing — and saying so is the point:
    // refusing it would make the ONE storage form an exclave can honour
    // unusable, which is the opposite of what the group check is for.
    if (spec.storage === 'recoverable') out.push(['sealing', `collection "${collection}" field "${field}" (storage:'recoverable')`])
    if (spec.storage === 'digest-only') out.push(['classify', `collection "${collection}" field "${field}" (storage:'digest-only')`])
    if (spec.equatable === true) out.push(['classify', `collection "${collection}" field "${field}" (equatable)`])
  }
  return out
}

/** Every (group, requirer) a set of enabled services needs — the pure half. */
export function serviceGroupRequirements(
  options: Readonly<Record<string, unknown>>,
): ReadonlyArray<readonly [CapsuleGroup, string]> {
  return SERVICE_GROUPS
    .filter(([key]) => options[key] != null)
    .map(([key, group]) => [group, `createNoydb({ ${key} })`] as const)
}

/** Refuse at `createNoydb()` — one assertion per enabled service. */
export function assertServicesSupported(
  options: Readonly<Record<string, unknown>>,
  caps: ReadonlySet<CapsuleGroup>,
): void {
  for (const [group, requirer] of serviceGroupRequirements(options)) {
    assertCapsuleSupports(caps, group, requirer)
  }
}

/** Refuse at `vault.collection()` — one assertion per declared field form. */
export function assertFieldsSupported(
  collection: string,
  decl: DeclaredFieldGroups,
  caps: ReadonlySet<CapsuleGroup>,
): void {
  for (const [group, requirer] of fieldGroupRequirements(collection, decl)) {
    assertCapsuleSupports(caps, group, requirer)
  }
}
