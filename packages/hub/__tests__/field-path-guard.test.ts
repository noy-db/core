/**
 * The shared field-path guard — the third instance of one class, guarded once.
 *
 * `moneyFields` validates its own paths and explains why in its header.
 * `classifiedFields` did not, and pilot-1 found the plaintext leak (#19).
 * `i18nFields` and `lookupFields` resolve paths through `getAtPath`, which
 * validates nothing — so a malformed declaration is silently inert, which is
 * the same failure with a different cost.
 *
 * ⚠️ The pairs below are the point. A guard that refuses malformed paths is
 * only half a guard: the other half is that it must NOT refuse the legitimate
 * grammar `getAtPath` actually supports, or it turns a silent bug into a loud
 * regression for working declarations.
 */
import { describe, it, expect } from 'vitest'
import { assertFieldPath, getAtPath } from '../src/kernel/paths.js'
import { ValidationError } from '../src/kernel/errors.js'

describe('assertFieldPath', () => {
  const ok = ['name', 'address.lineOne', 'a.b.c', 'contacts[].title', 'a.list[].b.c', 'field_2']
  for (const path of ok) {
    it(`accepts "${path}"`, () => {
      expect(() => assertFieldPath(path, 'i18nFields')).not.toThrow()
    })
  }

  const bad = [
    ['contacts[.name', 'stray bracket'],
    ['bad[syntax', 'unclosed bracket'],
    ['a..b', 'empty segment'],
    ['trailing.', 'trailing dot'],
    ['.leading', 'leading dot'],
    ['contacts[]', 'trailing wildcard with no leaf'],
    ['a.b[]', 'trailing wildcard with no leaf, nested'],
    ['', 'empty'],
  ] as const
  for (const [path, why] of bad) {
    it(`refuses "${path}" (${why})`, () => {
      expect(() => assertFieldPath(path, 'i18nFields')).toThrow(ValidationError)
    })
  }

  it('names the declaring family and the offending path', () => {
    try {
      assertFieldPath('contacts[.name', 'lookupFields')
    } catch (err) {
      expect((err as Error).message).toContain('lookupFields')
      expect((err as Error).message).toContain('contacts[.name')
    }
  })
})

describe('the guard matches what getAtPath can actually resolve', () => {
  // This is the property that makes the accept-list above trustworthy rather
  // than a second opinion: every path the guard ACCEPTS must be one the
  // resolver can reach a value through, and the two refusals below are exactly
  // the cases that silently resolved to nothing before the guard existed.
  const record = {
    name: 'n',
    address: { lineOne: 'L1' },
    contacts: [{ title: 'a' }, { title: 'b' }],
  }

  it('resolves every accepted shape', () => {
    expect(getAtPath(record, 'name')).toEqual(['n'])
    expect(getAtPath(record, 'address.lineOne')).toEqual(['L1'])
    expect(getAtPath(record, 'contacts[].title')).toEqual(['a', 'b'])
  })

  it('the refused shapes are exactly the ones that resolved to nothing', () => {
    // Before this guard these were accepted at declaration and behaved like
    // this at every read, for the life of the collection.
    expect(getAtPath(record, 'contacts[.title')).toEqual([])
    expect(getAtPath(record, 'contacts[]')).toEqual([])
  })
})
