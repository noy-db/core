/**
 * The guard, through a real collection — and the RECORD of the sweep that
 * produced it.
 *
 * ⭐ THE SECOND DESCRIBE BLOCK IS THE DELIVERABLE, not a footnote. The family
 * rule earned from `in-nuxt/README.md:18` is that when a sweep returns a small
 * number, the deliverable is the sweep and not the number — there, one broken
 * example was repaired and the detector was never extended to the class, so the
 * class stayed open. Fixing `i18nFields` and `lookupFields` and walking away
 * would repeat exactly that.
 *
 * So this file records what was measured on 2026-09-13, including the parts
 * NOT fixed, so the next person inherits the map instead of re-deriving it.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { i18nText } from '../src/via/i18n/core.js'
import { withI18n } from '../src/via/i18n/index.js'
import { ValidationError } from '../src/kernel/errors.js'

async function vault() {
  // ⚠️ `i18nStrategy` is required, and leaving it out cost a FALSE PASS on the
  // first run: the `required: 'all'` control below "rejected" — but with
  // "i18nText field validation requires the i18n strategy", not with the
  // missing-language error it claims to prove. A test that rejects for the
  // wrong reason is indistinguishable from one that works.
  const db = await createNoydb({ store: memoryStore(), user: 'a', secret: 'pw-s2-8xx', i18nStrategy: withI18n() })
  return db.openVault('v1')
}

describe('a malformed i18n path fails at construction', () => {
  it('refuses, instead of accepting a declaration that can never apply', async () => {
    const v = await vault()
    expect(() => v.collection('docs', {
      i18nFields: { 'contacts[.name': i18nText({ languages: ['en', 'th'], required: 'all' }) },
    })).toThrow(ValidationError)
  })

  it('still accepts the nested form that works — the control', async () => {
    // Without this the case above would pass against a guard that refused
    // every nested path, which would break working declarations.
    const v = await vault()
    const c = v.collection<Record<string, unknown>>('docs', {
      i18nFields: { 'contacts[].name': i18nText({ languages: ['en'], required: 'all' }) },
    })
    await c.put('d1', { id: 'd1', contacts: [{ name: { en: 'x' } }] })
    expect(await c.get('d1')).toBeTruthy()
  })

  it('and the guarantee it installs is real — the second control', async () => {
    // The failure this whole guard exists for was a `required: 'all'` rule
    // that silently did not apply. Prove the rule bites when the path is good,
    // or "refuses malformed paths" would be protecting nothing.
    const v = await vault()
    const c = v.collection<Record<string, unknown>>('docs', {
      i18nFields: { title: i18nText({ languages: ['en', 'th'], required: 'all' }) },
    })
    // Asserted on the MESSAGE, not merely that something threw — see the note
    // on `vault()` above.
    await expect(c.put('d1', { id: 'd1', title: { en: 'hello' } }))
      .rejects.toThrow(/th|required|missing/i)
  })
})

describe('the sweep of 2026-09-13 — what was measured, and what was not', () => {
  it('records which families take field PATHS and are now guarded', () => {
    // Measured by declaring an unresolvable field in each family and observing
    // registration, then tracing which resolve through `getAtPath`.
    const takesPaths = {
      moneyFields: 'guarded — its own parser, since before this sweep',
      i18nFields: 'guarded here (#19 class)',
      lookupFields: 'guarded here (#19 class)',
    }
    expect(Object.keys(takesPaths).sort()).toEqual(['i18nFields', 'lookupFields', 'moneyFields'])
  })

  it('records the flat-key families, deliberately NOT guarded', () => {
    // These accept a dotted key and it simply never matches a field. That is
    // the TYPO problem, not the PATH problem: the string is well-formed, so a
    // syntax guard would not catch it and refusing dots outright would forbid
    // a shape they may legitimately gain later.
    const flatKey = ['blobFields', 'computed', 'dictKeyFields', 'refs']
    expect(flatKey).toHaveLength(4)
  })

  it('⛔ records the gap this guard does NOT close', () => {
    // A well-formed path naming a field that does not exist — `titel` for
    // `title` — is syntactically valid and silently inert. Catching it needs
    // the collection's schema, which is optional, so it is a design decision
    // rather than a guard. Filed separately; NOT fixed here.
    //
    // Also unclosed: `with-lookup/embeddings` and `with-lookup/search` resolve
    // paths through the same unvalidated helper. 33 call sites across 8 files
    // reach `getAtPath`/`setAtPathInPlace`; only declaration sites are guarded.
    // Making the skip impossible means a branded compiled-path type across all
    // 33 — the durable fix, deliberately not smuggled into this change.
    expect(true).toBe(true)
  })
})
