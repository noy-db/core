/**
 * #19 — a dotted path in `classifiedFields` must be REFUSED at registration.
 *
 * ⛔ THE BUG THIS KILLS IS A PLAINTEXT LEAK, and its shape is what makes it
 * dangerous rather than merely wrong. Reported by pilot-1 against 0.7.0 and
 * measured again on this line:
 *
 *   classifiedFields: { 'account.password': spec }   // accepted, no warning
 *
 * registers cleanly, the write succeeds, and the secret then comes back IN
 * FULL PLAINTEXT from `get()` and `list()`. The only signal is `reveal()`
 * throwing — which a developer who believes the field is sealed has no reason
 * to call, because they can already read the value.
 *
 * So "misconfigured" and "not classified at all" are observationally
 * identical, while the developer's belief is that the secret is protected.
 * That is the wrong way round for a security primitive: the safe default of a
 * misunderstood declaration must be REFUSAL, not silent pass-through.
 *
 * ⭐ NOT A NOVEL CLASS — the same failure was already found and fixed one
 * family over. `via/money/paths.ts` parses nested paths at registration and
 * says so in its header: "The historical failure mode this kills: a
 * declared-but-unreachable path that was silently ignored, leaving the field
 * un-quantized — a latent 100× bug." `moneyFields` got that guard; the
 * classified family never did. Money loses accuracy when it slips; classified
 * fields lose the secret.
 *
 * ⚠️ The refusal says "not supported HERE", deliberately, not "never". Dotted
 * paths are meaningful in `moneyFields` and `i18nFields` — which is exactly
 * why reaching for one here is a natural mistake rather than an exotic one —
 * so the message has to point at the workaround instead of implying the whole
 * idea is wrong.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveClassifiedFields, ClassifiedConfigError,
  type ClassifiedFieldSpec, type ClassifiedGroup,
} from '../../src/via/classified/resolve.js'

const spec = (over: Partial<ClassifiedFieldSpec> = {}): ClassifiedFieldSpec => ({
  _noydbClassified: true, preset: 'test', storage: 'recoverable',
  list: { kind: 'omit' }, sensitivity: 'secret', ...over,
})

describe('#19 — a nested path cannot be declared classified', () => {
  it('refuses a dotted key, naming the field and the workaround', () => {
    expect(() => resolveClassifiedFields('clients', { 'account.password': spec() }))
      .toThrow(ClassifiedConfigError)

    try {
      resolveClassifiedFields('clients', { 'account.password': spec() })
    } catch (err) {
      const message = (err as Error).message
      // The offending declaration, so the developer can find it.
      expect(message).toContain('account.password')
      // The way out. A refusal that does not say what to do instead just
      // moves the guesswork rather than ending it.
      expect(message).toMatch(/top-level|promote/i)
    }
  })

  it('refuses a bracket path too', () => {
    expect(() => resolveClassifiedFields('clients', { 'logins[].password': spec() }))
      .toThrow(ClassifiedConfigError)
  })

  it('refuses a nested member inside a GROUP, not just a flat key', () => {
    // The group form reaches the same registration chokepoint, so a guard
    // that only covered flat keys would leave the leak open behind one extra
    // level of syntax.
    const group: ClassifiedGroup = {
      _noydbClassifiedGroup: true, preset: 'portal',
      members: { 'account.password': spec() },
    }
    expect(() => resolveClassifiedFields('clients', { portal: group }))
      .toThrow(ClassifiedConfigError)
  })

  it('still accepts ordinary top-level fields — the control', () => {
    // Without this, the three refusals above would pass just as well against
    // a guard that refused everything.
    const r = resolveClassifiedFields('clients', { password: spec(), pan: spec() })
    expect(Object.keys(r.byField).sort()).toEqual(['pan', 'password'])
  })

  it('accepts a field name containing an underscore or digit — not over-broad', () => {
    // The guard keys on path SYNTAX (`.` and `[`), so ordinary identifiers
    // that merely look unusual must be unaffected.
    const r = resolveClassifiedFields('clients', { account_password: spec(), secret2: spec() })
    expect(Object.keys(r.byField).sort()).toEqual(['account_password', 'secret2'])
  })
})
