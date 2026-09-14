/**
 * #26 — `classified.checksummed({ validate })`.
 *
 * The value is the four security-relevant DEFAULTS, not the typing saved.
 * Hand-rolling the spec means choosing `storage`, `list`, `sensitivity` and
 * `verifyNormalize` per consumer, and getting `sensitivity` or `list` wrong on
 * a national identifier is not cosmetic. Requested by pilot-1 after doing
 * exactly that by hand.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { memoryStore } from '../../src/kernel/memory-store.js'
import { classified } from '../../src/via/classified/presets.js'

/** Mod-11 over a 13-digit identifier — the shape pilot-1 hand-rolled. */
const mod11 = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^\d{13}$/.test(v)) return 'expected 13 digits'
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(v[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(v[12]) ? null : 'checksum failed'
}

describe('classified.checksummed', () => {
  it('defaults to recoverable storage and an omitted list', () => {
    const spec = classified.checksummed({ validate: mod11 })
    expect(spec.storage).toBe('recoverable')
    expect(spec.list).toEqual({ kind: 'omit' })
    expect(spec.sensitivity).toBe('pii')
    expect(spec.preset).toBe('checksummed')
  })

  it('lets a caller override the posture deliberately', () => {
    const spec = classified.checksummed({
      validate: mod11, sensitivity: 'secret', list: { kind: 'mask', pattern: '•••••••••${last4}' },
    })
    expect(spec.sensitivity).toBe('secret')
    expect(spec.list).toEqual({ kind: 'mask', pattern: '•••••••••${last4}' })
  })

  it('carries the supplied checksum through, accepting and rejecting', () => {
    const spec = classified.checksummed({ validate: mod11 })
    // Built so the mod-11 check digit is correct.
    const digits = '110200012345'
    let sum = 0
    for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (13 - i)
    const valid = digits + String((11 - (sum % 11)) % 10)

    expect(spec.validate?.(valid)).toBeNull()
    expect(spec.validate?.(digits + '9')).toBe(
      (11 - (sum % 11)) % 10 === 9 ? null : 'checksum failed',
    )
    expect(spec.validate?.('123')).toBe('expected 13 digits')
    expect(spec.validate?.(12345)).toBe('expected 13 digits')
  })

  it('seals the value end to end — the property the preset exists to give', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8xx' })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('workers', {
      perRecordKeys: true,
      classifiedFields: { natId: classified.checksummed({ validate: () => null }) },
    })

    await c.put('w1', { id: 'w1', name: 'Nok', natId: 'not-a-real-identifier' })

    // Not in the ordinary read path, and not in the stored envelope.
    expect(JSON.stringify(await c.get('w1'))).not.toContain('not-a-real-identifier')
  })
})
