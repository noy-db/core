/**
 * What the plaintext capsule actually does — and, just as importantly, what it
 * refuses and what it does NOT protect.
 *
 * ⚠️ The tamper section is deliberately written as DETECTION, not defence.
 * There is no secret in exclave mode, so a party who can write a row can also
 * compute its stamp. Asserting "a hostile store cannot forge" here would be a
 * false security claim, and a passing test asserting it would be worse than no
 * test — see the final case, which pins the limitation rather than hiding it.
 */
import { describe, it, expect } from 'vitest'
import { CapsuleNotSupportedError } from '@noy-db/hub/capsule'
import * as exclave from '../src/index.js'
import { plainPrimitives } from '../src/primitives.js'

const aad = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('the body passes through, readable', () => {
  it('stores the plaintext verbatim — that is the whole point', async () => {
    const key = await exclave.generateDEK()
    const json = JSON.stringify({ invoice: 'INV-1', total: 42 })
    const { iv, data } = await exclave.encrypt(json, key, aad('rows/r1'))

    // The body is NOT transformed. A DynamoDB console, a jq pipeline or
    // another team's tool reads this without noy-db.
    expect(data).toBe(json)
    expect(JSON.parse(data)).toMatchObject({ invoice: 'INV-1' })
    // The stamp is separate and does not encode the body.
    expect(iv).toMatch(/^[0-9a-f]{64}$/)
  })

  it('round-trips through decrypt', async () => {
    const key = await exclave.generateDEK()
    const { iv, data } = await exclave.encrypt('hello', key, aad('rows/r1'))
    expect(await exclave.decrypt(iv, data, key, aad('rows/r1'))).toBe('hello')
  })
})

describe('the stamp detects writes that did not come from this format', () => {
  it('refuses a body edited underneath it', async () => {
    const key = await exclave.generateDEK()
    const { iv } = await exclave.encrypt('{"total":42}', key, aad('rows/r1'))
    await expect(exclave.decrypt(iv, '{"total":9999}', key, aad('rows/r1')))
      .rejects.toThrow(/integrity stamp does not match/)
  })

  it('refuses a row moved to a different identity', async () => {
    // The AAD carries collection/id/tier/author, so relocation changes it.
    const key = await exclave.generateDEK()
    const { iv, data } = await exclave.encrypt('{"total":42}', key, aad('rows/r1'))
    await expect(exclave.decrypt(iv, data, key, aad('rows/r2')))
      .rejects.toThrow(/integrity stamp does not match/)
    await expect(exclave.decrypt(iv, data, key, aad('other/r1')))
      .rejects.toThrow(/integrity stamp does not match/)
  })

  it('distinguishes absent AAD from empty AAD', async () => {
    const key = await exclave.generateDEK()
    const { iv, data } = await exclave.encrypt('x', key, undefined)
    await expect(exclave.decrypt(iv, data, key, new Uint8Array(0)))
      .rejects.toThrow(/integrity stamp does not match/)
  })

  it('⛔ does NOT defend against a party that can write rows — pinned, not hidden', async () => {
    // This is the honest limit of exclave mode, asserted so nobody later reads
    // the passing tamper cases above as a security guarantee. An attacker who
    // controls the store knows the AAD and the body, so it can recompute a
    // valid stamp. In enclave-aes the same forgery is impossible because the
    // AAD is bound under a key the store has never seen.
    const key = await exclave.generateDEK()
    const forgedBody = '{"total":9999}'
    const { iv: forgedStamp } = await exclave.encrypt(forgedBody, key, aad('rows/r1'))

    // The forgery verifies. That is the documented trust boundary, not a bug.
    await expect(exclave.decrypt(forgedStamp, forgedBody, key, aad('rows/r1')))
      .resolves.toBe(forgedBody)
  })
})

describe('refusals are typed and name their group', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown, string]> = [
    ['deriveKey', () => exclave.deriveKey(), 'authenticate'],
    ['wrapKey', () => exclave.wrapKey(), 'seal'],
    ['exportDekSet', () => exclave.exportDekSet(), 'seal'],
    ['encryptDeterministic', () => exclave.encryptDeterministic(), 'deterministic'],
    ['deriveSealedFieldKey', () => exclave.deriveSealedFieldKey(), 'sealing'],
    ['mintBidxTag', () => exclave.mintBidxTag(), 'classify'],
  ]

  for (const [name, call, group] of cases) {
    it(`${name} refuses with group "${group}"`, () => {
      try {
        call()
        throw new Error(`${name} did not refuse`)
      } catch (err) {
        expect(err).toBeInstanceOf(CapsuleNotSupportedError)
        expect((err as CapsuleNotSupportedError).group).toBe(group)
        // The message must name the requirer, or an operator sees a refusal
        // with no way to tell which package asked for it.
        expect((err as Error).message).toContain('@noy-db/exclave-plain')
      }
    })
  }

  it('a refusal is thrown, never returned as undefined', () => {
    // A capsule that returned undefined here would let hub write an envelope
    // with a missing field and fail much later, somewhere else.
    expect(() => plainPrimitives.wrapCek(null as never, null as never)).toThrow(CapsuleNotSupportedError)
  })
})

describe('capabilities()', () => {
  it('declares exactly the groups this capsule implements', () => {
    expect([...exclave.capabilities()].sort()).toEqual(['cipher', 'codec', 'digest', 'sign'])
  })

  it('refuses authenticate and seal — the exclave prefix rule', () => {
    expect(exclave.capabilities().has('authenticate')).toBe(false)
    expect(exclave.capabilities().has('seal')).toBe(false)
  })

  it('cannot be widened by a caller', () => {
    // `Object.freeze` does NOT freeze a Set's contents (measured in Stage B),
    // so the mutators are replaced rather than relied upon to be frozen.
    expect(() => (exclave.capabilities() as Set<never>).add('seal' as never)).toThrow(/not mutable/)
    expect(() => (exclave.capabilities() as Set<never>).clear()).toThrow(/not mutable/)
  })
})
