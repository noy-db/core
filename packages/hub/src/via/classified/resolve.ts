/** Flatten a classifiedFields config into a per-field map + rider computed entries. @module */

import { isClassifiedGroup, type ClassifiedEntry, type ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedConfigError } from './errors.js'

export type { ClassifiedEntry, ClassifiedFieldSpec, ClassifiedGroup, ClassifiedList } from './descriptor.js'
export { ClassifiedConfigError } from './errors.js'

export interface ResolvedClassified {
  readonly byField: Record<string, ClassifiedFieldSpec>
  readonly riderComputed: Record<string, (record: Record<string, unknown>) => unknown>
}

export function resolveClassifiedFields(
  collection: string,
  config: Record<string, ClassifiedEntry>,
): ResolvedClassified {
  const byField: Record<string, ClassifiedFieldSpec> = {}
  const claim = (field: string, spec: ClassifiedFieldSpec): void => {
    // ⛔ #19 — REFUSE A NESTED PATH. Declaring `'account.password'` used to
    // register cleanly and seal NOTHING: the write succeeded and the secret
    // came back in full plaintext from `get()` and `list()`, with the only
    // signal being a `reveal()` that a developer who believes the field is
    // sealed has no reason to call. "Misconfigured" and "not classified at
    // all" were observationally identical, which is the wrong way round for a
    // security primitive — a misunderstood declaration must fail closed.
    //
    // Guarded HERE rather than at the two call sites below because `claim` is
    // the one chokepoint both the flat form and a group's members pass
    // through; a guard on the flat key alone would leave the leak reachable
    // behind one extra level of syntax.
    //
    // ⭐ `via/money/paths.ts` already carries this lesson for `moneyFields`
    // ("a declared-but-unreachable path that was silently ignored ... a latent
    // 100× bug"). Same class, different family — and here the cost is the
    // secret rather than the precision.
    if (field.includes('.') || field.includes('[')) {
      throw new ClassifiedConfigError(collection,
        `field "${field}" is a nested path, which classifiedFields does not support — ` +
        `it would register without error and seal nothing, returning the value in plaintext. ` +
        `Promote it to a top-level field on this collection (or its own document) and declare that instead. ` +
        `(Dotted paths ARE supported by moneyFields and i18nFields, which is why this is an easy mistake.)`)
    }
    if (byField[field] !== undefined) {
      throw new ClassifiedConfigError(collection,
        `field "${field}" is claimed twice — storage forms are mutually exclusive per field (R5): ` +
        `a field is digest-only OR recoverable OR never, exactly one`)
    }
    byField[field] = spec
  }
  for (const [key, entry] of Object.entries(config)) {
    if (isClassifiedGroup(entry)) {
      for (const [field, spec] of Object.entries(entry.members)) claim(field, spec)
    } else {
      claim(key, entry)
    }
  }
  const riderComputed: Record<string, (record: Record<string, unknown>) => unknown> = {}
  for (const [field, spec] of Object.entries(byField)) {
    for (const [name, rider] of Object.entries(spec.riders ?? {})) {
      const companion = `${field}_${name}`
      if (byField[companion] !== undefined || riderComputed[companion] !== undefined) {
        throw new ClassifiedConfigError(collection, `rider companion "${companion}" collides with a declared field`)
      }
      riderComputed[companion] = (record) =>
        record[field] === undefined ? undefined : rider(record[field])
    }
  }
  return { byField, riderComputed }
}
