/**
 * #34 — "was the erasure complete?", which is the only question a caller of
 * {@link vault.forget} actually has, and the one `ForgetResult` could not
 * answer.
 *
 * ⛔ THE PROBLEM THIS SOLVES. `ForgetResult` carries ELEVEN independent residue
 * channels. None of them throws. Only two say in their own doc that non-empty
 * means erasure is INCOMPLETE. So "erasure succeeded" is not
 * `recordsShredded > 0` — it is all eleven empty — while the result's SHAPE
 * suggests the opposite: the counts read like a success report and the residues
 * read like diagnostics you consult when something looks wrong. A consumer
 * building a subject-facing "your data has been deleted" on the obvious field
 * is making a false statement in writing, and nothing in the surface tells them.
 *
 * ⭐ WHY THIS IS DEFAULT-DENY AND NOT A LIST OF ELEVEN NAMES. Enumerating the
 * channels would reproduce the defect one level up: every new channel would
 * silently weaken every existing caller's check, so a correct caller today
 * becomes an incorrect one tomorrow with no diagnostic anywhere — a correctness
 * regression delivered by an additive change, which is the kind that passes
 * review. Instead EVERY array-valued field counts as residue unless it appears
 * in {@link NON_RESIDUE_FIELDS}. A twelfth channel is therefore included by
 * construction, and exempting a field is a deliberate edit with a visible diff.
 * `__tests__/34-erasure-completeness.test.ts` fails if any array field is
 * neither a known channel nor exempt, so the exemption list cannot rot quietly.
 *
 * ⚠️ `derivedResidueFrozen` counts as incomplete, and that is CORRECT rather
 * than a bug to fix. An append-only closed period or a frozen receipt keeps the
 * subject's contribution permanently, by design. The erasure genuinely is not
 * total, and a caller who must answer a subject needs to know that — which is
 * precisely why it must not be quietly excluded here. What a consumer does with
 * it (a lawful-retention position) belongs in their layer, not this one.
 *
 * ⛔ SCOPE, deliberately: this reports what the MECHANISM did. It does not know
 * whether a retention is lawful, and must never grow vocabulary implying it
 * does — `blobsRetainedShared` means "still referenced", never "retained
 * lawfully". The legal decomposition sits above this, in the consumer.
 */
import type { ForgetResult } from './strategy.js'

/**
 * Array-valued `ForgetResult` fields that are NOT failure channels.
 *
 * ⚠️ Adding a name here says "a non-empty value in this field does not mean the
 * erasure was incomplete". That is a substantive claim about erasure semantics
 * — make it deliberately, and say why on the line.
 */
const NON_RESIDUE_FIELDS: ReadonlySet<string> = new Set([
  // The collections that had at least one record shredded: a WORK RECORD of
  // what was touched, not a report of anything left behind.
  'collections',
])

/** The verdict {@link erasureCompleteness} returns. */
export interface ErasureCompleteness {
  /**
   * `true` only when every residue channel is empty. ⛔ This — not
   * `recordsShredded > 0` — is what "the subject's data was erased" means.
   */
  readonly complete: boolean
  /** Names of the channels that are non-empty, sorted. Empty iff `complete`. */
  readonly channels: readonly string[]
  /** The non-empty channels and their entries, for a caller that must report which. */
  readonly residue: Readonly<Record<string, readonly unknown[]>>
}

/**
 * Decide whether a {@link ForgetResult} represents a COMPLETE erasure.
 *
 * ```ts
 * const result = await vault.forget(subjectId)
 * const { complete, channels, residue } = erasureCompleteness(result)
 * if (!complete) {
 *   // Do NOT tell the subject their data is gone. `channels` says what remains;
 *   // some of it (a frozen period aggregate) is permanent by design.
 * }
 * ```
 *
 * Every array field of the result is treated as a residue channel except those
 * in {@link NON_RESIDUE_FIELDS} — see this module's doc for why that direction.
 */
export function erasureCompleteness(result: ForgetResult): ErasureCompleteness {
  const residue: Record<string, readonly unknown[]> = {}
  for (const [key, value] of Object.entries(result as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value) || NON_RESIDUE_FIELDS.has(key) || value.length === 0) continue
    residue[key] = value as readonly unknown[]
  }
  const channels = Object.keys(residue).sort()
  return { complete: channels.length === 0, channels, residue }
}
