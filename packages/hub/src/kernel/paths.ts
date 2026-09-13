/**
 * Generic dotted-path / `[]`-wildcard record helpers. Kernel-owned:
 * these carry zero i18n logic — they were extracted out of
 * `via/i18n/core.ts` (Task 7, #623) so kernel call-sites (put-time
 * validation, densify) can import them without a spine→service edge.
 *
 * @internal
 */
import { ValidationError } from './errors.js'

/**
 * A path segment: a key, optionally an array wildcard (`contacts[]`).
 * `[^.[\]]+` keeps `.`, `[` and `]` out of the key itself, so a stray
 * bracket is a syntax error rather than part of a field name.
 */
const SEGMENT_RE = /^[^.[\]]+(\[\])?$/

/**
 * Refuse a malformed field path AT DECLARATION TIME.
 *
 * ⛔ WHY THIS EXISTS. {@link getAtPath} performs no validation by design — it
 * answers "what is at this path", and "nothing" is a legitimate answer for an
 * optional field or an empty array. The consequence is that a MALFORMED path
 * is indistinguishable from an absent value: `'contacts[.name'` contains no
 * `[].` and no `.`, so it falls through to `obj['contacts[.name']`, resolves
 * to `undefined`, and the declaration does nothing. Forever. Silently.
 *
 * Measured 2026-09-13: an `i18nFields` declaration with `required: 'all'` and
 * a malformed path accepted a record missing every required language, while
 * the same spec on a well-formed path refused it. The guarantee was not
 * weakened — it was never installed.
 *
 * ⭐ SAME CLASS AS core#19 AND `moneyFields`. `via/money/paths.ts` already
 * guards its own grammar and says why in its header ("a declared-but-
 * unreachable path that was silently ignored ... a latent 100× bug");
 * `classifiedFields` did not, and a consumer found the leak. This is the third
 * instance, which is why the check lives HERE, beside the resolver every
 * path-taking family shares, rather than being written a third time.
 *
 * ⚠️ SYNTAX ONLY. A well-formed path naming a field that does not exist
 * (`titel` for `title`) is NOT caught here and cannot be — that needs the
 * collection's schema, which is not always declared. It is a real and separate
 * gap; see the issue filed alongside this guard.
 *
 * Trailing `[]` is refused because `getAtPath` cannot consume it: the wildcard
 * is recognised as the three-character marker `[].`, so `'contacts[]'` with
 * nothing after it is read as an ordinary key and resolves to nothing.
 */
export function assertFieldPath(path: string, context: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ValidationError(`${context}: field path must be a non-empty string`)
  }
  const parts = path.split('.')
  parts.forEach((part, i) => {
    if (!SEGMENT_RE.test(part)) {
      throw new ValidationError(
        `${context}: invalid field path "${path}" — segment "${part}" must be a key or "key[]". ` +
        `A malformed path is not an error at read time: it simply resolves to nothing, so the ` +
        `declaration would be silently inert.`)
    }
    if (part.endsWith('[]') && i === parts.length - 1) {
      throw new ValidationError(
        `${context}: invalid field path "${path}" — an array wildcard must be followed by a leaf ` +
        `(e.g. "${part}.name"). A trailing "[]" resolves to nothing.`)
    }
  })
}

/**
 * Return all leaf values at `path`, expanding `[].` array wildcards.
 *
 * - `'name'`              → `[obj.name]`
 * - `'address.lineOne'`   → `[obj.address.lineOne]`
 * - `'contacts[].title'`  → `[obj.contacts[0].title, obj.contacts[1].title, …]`
 *
 * Returns an empty array when the path does not resolve (missing key,
 * wrong type, etc.). Used by `enforceI18nOnPut` to validate nested fields.
 */
export function getAtPath(obj: Record<string, unknown>, path: string): unknown[] {
  const arrayIdx = path.indexOf('[].')
  if (arrayIdx !== -1) {
    const arrayKey = path.slice(0, arrayIdx)
    const restPath = path.slice(arrayIdx + 3)
    const arr = obj[arrayKey]
    if (!Array.isArray(arr)) return []
    return arr.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      return getAtPath(item as Record<string, unknown>, restPath)
    })
  }
  const dotIdx = path.indexOf('.')
  if (dotIdx !== -1) {
    const head = path.slice(0, dotIdx)
    const rest = path.slice(dotIdx + 1)
    const nested = obj[head]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return []
    return getAtPath(nested as Record<string, unknown>, rest)
  }
  const val = obj[path]
  return val !== undefined ? [val] : []
}

/**
 * Mutate `obj` in-place, setting `value` at the nested `path`.
 * Supports dot notation (`'address.lineOne'`) but not array wildcards —
 * auto-translate on `contacts[].title` style paths is not supported.
 */
export function setAtPathInPlace(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const dotIdx = path.indexOf('.')
  if (dotIdx !== -1) {
    const head = path.slice(0, dotIdx)
    const rest = path.slice(dotIdx + 1)
    const nested = obj[head]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return
    setAtPathInPlace(nested as Record<string, unknown>, rest, value)
    return
  }
  obj[path] = value
}
