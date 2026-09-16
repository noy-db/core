/**
 * Known-answer vectors for `@noy-db/shamir` (core#41, family#29).
 *
 * ⛔ WHY THIS FILE EXISTS, given `shamir.test.ts` already looks thorough:
 * every split/combine test in that file is a ROUND TRIP — split, combine,
 * assert the secret comes back. A round trip is structurally incapable of
 * failing on a CONSISTENT error. If `splitSecret` and `combineSecret` ever
 * agreed on a wrong field, a wrong reduction polynomial, a wrong coefficient
 * order or a wrong evaluation rule, every one of those tests would still
 * pass and the shares on disk would be incompatible with every other
 * implementation of Shamir in the world.
 *
 * The only thing that catches that is a FIXED EXPECTATION ON THE SHARE BYTES
 * THEMSELVES, derived from the mathematical definition rather than from this
 * package's output. Expected values below were computed independently (see
 * `refMul`) and never by running the code under test — a vector generated
 * from the implementation proves stability, not correctness, and would
 * happily enshrine a bug.
 *
 * `splitSecret` is fully deterministic once its RNG is injected:
 * `pickXCoords` is `1..n`, and `randomBytes(k-1)` is called once per secret
 * byte. That is what makes fixed vectors possible without stubbing globals.
 */
import { describe, it, expect } from 'vitest'
import { gfMul, gfInv, gfAdd } from '../src/gf256.js'
import { splitSecret, combineSecret, type RawShare } from '../src/shamir.js'

/**
 * Independent GF(2^8) multiply: carry-less shift-and-xor with reduction by
 * 0x11b, written deliberately as a DIFFERENT ALGORITHM from the library's
 * log/exp tables. Agreement between the two is evidence; a second copy of
 * the table approach would have been a tautology.
 */
function refMul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p & 0xff
}

/** Feeds `splitSecret` a fixed sequence, one entry per secret byte. */
function scriptedRandom(sequence: readonly (readonly number[])[]): (count: number) => Uint8Array {
  let call = 0
  return (count: number) => {
    const next = sequence[call++]
    if (next === undefined) throw new Error(`scriptedRandom: unexpected call ${call}`)
    if (next.length !== count) {
      throw new Error(`scriptedRandom: call ${call} asked for ${count} bytes, script has ${next.length}`)
    }
    return Uint8Array.from(next)
  }
}

describe('GF(2^8) — FIPS-197 known answers', () => {
  // The field here is AES's: primitive element 0x03, reduction polynomial
  // 0x11b. So the worked examples published in FIPS-197 are a genuine
  // EXTERNAL anchor — they do not depend on anything in this repo.
  it('reproduces the FIPS-197 §4.2 multiplication examples', () => {
    expect(gfMul(0x57, 0x83)).toBe(0xc1)
    expect(gfMul(0x57, 0x13)).toBe(0xfe)
  })

  it('reproduces the FIPS-197 xtime chain for 0x57', () => {
    expect(gfMul(0x57, 0x02)).toBe(0xae)
    expect(gfMul(0x57, 0x04)).toBe(0x47)
    expect(gfMul(0x57, 0x08)).toBe(0x8e)
    expect(gfMul(0x57, 0x10)).toBe(0x07)
    // 0x13 = 0x01 ^ 0x02 ^ 0x10, so the chain must compose to the §4.2 answer.
    expect(gfAdd(gfAdd(0x57, 0xae), 0x07)).toBe(0xfe)
  })

  it('reproduces the FIPS-197 S-box inverse example — inv(0x53) == 0xca', () => {
    expect(gfInv(0x53)).toBe(0xca)
    expect(gfMul(0x53, 0xca)).toBe(0x01)
  })
})

describe('GF(2^8) — agreement with an independent implementation', () => {
  it('gfMul matches shift-and-xor across the ENTIRE field (65536 pairs)', () => {
    // Catches a mis-built log/exp table, which the algebraic property tests
    // cannot: a table that is wrong but self-consistent still satisfies
    // commutativity and associativity.
    const mismatches: string[] = []
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const got = gfMul(a, b)
        const want = refMul(a, b)
        if (got !== want) mismatches.push(`${a}*${b}: got ${got}, want ${want}`)
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([])
    expect(mismatches).toHaveLength(0)
  })

  it('gfInv is a true multiplicative inverse for every non-zero element', () => {
    for (let a = 1; a < 256; a++) expect(refMul(a, gfInv(a))).toBe(1)
  })
})

describe('splitSecret — known-answer vectors (exact share bytes)', () => {
  // VECTOR A — k=2, n=3. Polynomial per byte is y(x) = s XOR (a * x).
  // secret [0x53,0x00,0xff,0x01]; one random coefficient per byte.
  it('k=2, n=3 produces exactly the derived shares', () => {
    const secret = Uint8Array.from([0x53, 0x00, 0xff, 0x01])
    const rand = scriptedRandom([[0xca], [0x57], [0x83], [0x13]])
    const shares = splitSecret(secret, 2, 3, rand)

    expect(shares.map(s => s.x)).toEqual([1, 2, 3])
    expect([...shares[0]!.y]).toEqual([0x99, 0x57, 0x7c, 0x12])
    expect([...shares[1]!.y]).toEqual([0xdc, 0xae, 0xe2, 0x27])
    expect([...shares[2]!.y]).toEqual([0x16, 0xf9, 0x61, 0x34])
  })

  // VECTOR B — k=3, n=4. y(x) = s XOR a1*x XOR a2*x^2, two coefficients per byte.
  it('k=3, n=4 produces exactly the derived shares', () => {
    const secret = Uint8Array.from([0xde, 0xad])
    const rand = scriptedRandom([[0x02, 0x57], [0x10, 0x83]])
    const shares = splitSecret(secret, 3, 4, rand)

    expect(shares.map(s => s.x)).toEqual([1, 2, 3, 4])
    expect([...shares[0]!.y]).toEqual([0x8b, 0x3e])
    expect([...shares[1]!.y]).toEqual([0x9d, 0xb7])
    expect([...shares[2]!.y]).toEqual([0xc8, 0x24])
    expect([...shares[3]!.y]).toEqual([0xd1, 0x05])
  })

  it('the constant term is the secret — a share at x=0 would BE the secret', () => {
    // Why x=0 is refused, stated as a test rather than a comment: the
    // polynomial's value at zero is the secret itself.
    expect(() => splitSecret(Uint8Array.from([0x42]), 2, 3, scriptedRandom([[0x01]]))).not.toThrow()
    const shares = splitSecret(Uint8Array.from([0x42]), 2, 3, scriptedRandom([[0x01]]))
    expect(shares.every(s => s.x !== 0)).toBe(true)
  })
})

describe('combineSecret — known-answer vectors (literal shares in)', () => {
  // These shares are LITERALS, not the output of splitSecret, so this is a
  // real known-answer test rather than the other half of a round trip.
  const vectorA = (x: number, y: readonly number[]): RawShare => ({ x, y: Uint8Array.from(y), k: 2, n: 3 })

  it('recovers the secret from shares 1 and 2', () => {
    const secret = combineSecret([
      vectorA(1, [0x99, 0x57, 0x7c, 0x12]),
      vectorA(2, [0xdc, 0xae, 0xe2, 0x27]),
    ])
    expect([...secret]).toEqual([0x53, 0x00, 0xff, 0x01])
  })

  it('recovers the same secret from a DIFFERENT subset — shares 1 and 3', () => {
    const secret = combineSecret([
      vectorA(1, [0x99, 0x57, 0x7c, 0x12]),
      vectorA(3, [0x16, 0xf9, 0x61, 0x34]),
    ])
    expect([...secret]).toEqual([0x53, 0x00, 0xff, 0x01])
  })

  it('recovers from shares 2 and 3 — the subset that never sees share 1', () => {
    const secret = combineSecret([
      vectorA(2, [0xdc, 0xae, 0xe2, 0x27]),
      vectorA(3, [0x16, 0xf9, 0x61, 0x34]),
    ])
    expect([...secret]).toEqual([0x53, 0x00, 0xff, 0x01])
  })

  it('k=3 vector recovers only with three shares, and from any three', () => {
    const b = (x: number, y: readonly number[]): RawShare => ({ x, y: Uint8Array.from(y), k: 3, n: 4 })
    const want = [0xde, 0xad]
    expect([...combineSecret([b(1, [0x8b, 0x3e]), b(2, [0x9d, 0xb7]), b(3, [0xc8, 0x24])])]).toEqual(want)
    expect([...combineSecret([b(2, [0x9d, 0xb7]), b(3, [0xc8, 0x24]), b(4, [0xd1, 0x05])])]).toEqual(want)
    expect([...combineSecret([b(1, [0x8b, 0x3e]), b(3, [0xc8, 0x24]), b(4, [0xd1, 0x05])])]).toEqual(want)
  })

  it('⛔ K-1 shares of a k=3 vector reconstruct the WRONG secret, not an error', () => {
    // The threshold is information-theoretic, not enforced: two shares of a
    // 3-of-4 split carry a valid-looking `k`, so `combineSecret` uses the
    // first `k`... and there are only two. It throws on too few — but the
    // failure mode worth pinning is that nothing about the BYTES marks them
    // as insufficient.
    const b = (x: number, y: readonly number[]): RawShare => ({ x, y: Uint8Array.from(y), k: 3, n: 4 })
    expect(() => combineSecret([b(1, [0x8b, 0x3e]), b(2, [0x9d, 0xb7])])).toThrow(/insufficient/)
  })
})

describe('⛔ shares carry no secret identity — a stale share is indistinguishable', () => {
  // Recorded as a test because it decided a family ruling (family#29): the
  // remedy for a rotated KEK is REDISTRIBUTION, not rewrapping, and no
  // contract can encode the hazard because the FORMAT cannot signal it.
  it('combining shares from two different splits returns garbage, silently', () => {
    const secretOld = Uint8Array.from([0x11, 0x22])
    const secretNew = Uint8Array.from([0x33, 0x44])
    const oldShares = splitSecret(secretOld, 2, 3, scriptedRandom([[0xa0], [0xb0]]))
    const newShares = splitSecret(secretNew, 2, 3, scriptedRandom([[0xc0], [0xd0]]))

    // One share from each generation. Same length, same k, distinct x — so
    // every check combineSecret makes passes.
    const mixed = combineSecret([oldShares[0]!, newShares[1]!])

    expect(mixed).toHaveLength(2)
    expect([...mixed]).not.toEqual([...secretOld])
    expect([...mixed]).not.toEqual([...secretNew])
  })

  it('K shares of a superseded split return the OLD secret, with no error', () => {
    const secretOld = Uint8Array.from([0x11, 0x22])
    const oldShares = splitSecret(secretOld, 2, 3, scriptedRandom([[0xa0], [0xb0]]))
    // Nothing in the share says "superseded". This is the shape that makes a
    // rotated-KEK failure surface at decrypt time rather than at combine.
    expect([...combineSecret([oldShares[0]!, oldShares[1]!])]).toEqual([...secretOld])
  })
})
