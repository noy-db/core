/**
 * #25 — a declaration naming a field the collection does not have is refused.
 *
 * The third and last step of the same class. #19 was a nested path that sealed
 * nothing; the syntax guard was a malformed path that resolved to nothing;
 * this is a WELL-FORMED path naming a field that does not exist — `titel` for
 * `title` — which is equally inert and which no syntax check can catch.
 *
 * ⚠️ THE SILENCE CASES ARE THE IMPORTANT ONES. A guard that refuses unknown
 * fields is easy; a guard that refuses them ONLY when it can actually know is
 * the whole difficulty. `schemaFieldKeys` returns `undefined` for a
 * schema-less or unreadable-validator collection, and those fields are REAL —
 * refusing them would break working collections to fix a silent one, which is
 * a worse trade. The derivation registry already made this call and its header
 * says so; this follows it rather than re-deciding it.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { i18nText } from '../src/via/i18n/core.js'
import { dict } from '../src/via/lookup/descriptor.js'
import { withI18n } from '../src/via/i18n/index.js'
import { ValidationError } from '../src/kernel/errors.js'

async function vault() {
  const db = await createNoydb({ store: memoryStore(), user: 'a', secret: 'pw-s2-8xx', i18nStrategy: withI18n() })
  return db.openVault('v1')
}

const schema = z.object({
  id: z.string(),
  title: z.record(z.string(), z.string()),
  contacts: z.array(z.object({ name: z.record(z.string(), z.string()) })).optional(),
})

describe('#25 — with a readable schema, an unknown field is refused', () => {
  it('refuses a misspelt field', async () => {
    const v = await vault()
    expect(() => v.collection('docs', {
      schema,
      i18nFields: { titel: i18nText({ languages: ['en'], required: 'all' }) },
    })).toThrow(ValidationError)
  })

  it('names the field, the family and the collection', async () => {
    const v = await vault()
    // ⚠️ Assert it throws FIRST. The try/catch below runs no assertion at all
    // when nothing is thrown, so on its own it passed while the guard was
    // inert — the same wrong-reason pass this whole class is about.
    expect(() => v.collection('docs', { schema, i18nFields: { titel: i18nText({ languages: ['en'], required: 'all' }) } }))
      .toThrow(ValidationError)
    try {
      v.collection('docs', { schema, i18nFields: { titel: i18nText({ languages: ['en'], required: 'all' }) } })
      throw new Error('unreachable — the line above must throw')
    } catch (err) {
      const m = (err as Error).message
      expect(m).toContain('titel')
      expect(m).toContain('i18nFields')
      expect(m).toContain('docs')
    }
  })

  it('accepts the correctly spelt field — the control', async () => {
    const v = await vault()
    expect(() => v.collection('docs', {
      schema,
      i18nFields: { title: i18nText({ languages: ['en'], required: 'all' }) },
    })).not.toThrow()
  })

  it('checks the ROOT of a nested path, and accepts a real root', async () => {
    const v = await vault()
    expect(() => v.collection('docs', {
      schema,
      i18nFields: { 'contacts[].name': i18nText({ languages: ['en'], required: 'all' }) },
    })).not.toThrow()
  })

  it('refuses a nested path whose ROOT does not exist', async () => {
    const v = await vault()
    expect(() => v.collection('docs', {
      schema,
      i18nFields: { 'contakts[].name': i18nText({ languages: ['en'], required: 'all' }) },
    })).toThrow(ValidationError)
  })
})

describe('#25 — the guard stays silent when it cannot know', () => {
  it('says nothing about a collection with NO schema', async () => {
    // The fields are real; they are simply not enumerable. Refusing here would
    // break every schema-less collection in existence.
    const v = await vault()
    expect(() => v.collection('docs', {
      i18nFields: { anything_at_all: i18nText({ languages: ['en'], required: 'all' }) },
    })).not.toThrow()
  })

  it('says nothing about a schema whose shape cannot be read', async () => {
    const v = await vault()
    expect(() => v.collection('docs', {
      schema: z.string().transform(s => ({ id: s })) as never,
      i18nFields: { whatever: i18nText({ languages: ['en'], required: 'all' }) },
    })).not.toThrow()
  })
})

describe('#25 — lookupFields is deliberately NOT checked', () => {
  // Measured, not assumed: extending the existence check to lookupFields broke
  // `composite-triggerby.test.ts`, which exists to pin that a match field
  // "declared only via lookupFields" must not false-positive. A via family's
  // key can be a DECLARATION rather than a REFERENCE, so existence-checking has
  // to be justified per family.
  it('accepts a lookup field absent from the schema — it DECLARES, not references', async () => {
    const v = await vault()
    expect(() => v.collection('docs', {
      schema,
      lookupFields: { clientTag: dict('clientTag') },
    })).not.toThrow()
  })

  it('and the guard is LIVE on that same collection — the control', async () => {
    // ⚠️ Without this the case above passes vacuously. `declaredFieldAllowList`
    // returns `undefined` — meaning "do not check" — for any collection whose
    // schema it cannot enumerate, and a not-throwing assertion cannot tell that
    // apart from the exemption it means to pin. Same schema, same vault: the
    // i18n typo must still be refused, or the case above proves nothing.
    const v = await vault()
    expect(() => v.collection('docs', {
      schema,
      lookupFields: { clientTag: dict('clientTag') },
      i18nFields: { titel: i18nText({ languages: ['en'], required: 'all' }) },
    })).toThrow(ValidationError)
  })
})

describe('#25 — the allow-list is wider than the schema, deliberately', () => {
  it('accepts a field another via family declares', async () => {
    // `lookupFields` and `i18nFields` both declare fields; a field declared by
    // one is a real field for the other, even when the schema predates it.
    const v = await vault()
    expect(() => v.collection('docs', {
      schema,
      fieldMeta: { extra: {} as never },
      i18nFields: { extra: i18nText({ languages: ['en'], required: 'all' }) },
    })).not.toThrow()
  })
})
