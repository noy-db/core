import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/capsule/enclave-aes/index.js'
import { normalizeForVerify } from '../../src/capsule/enclave-aes/classify/normalize.js'
import { mintBidxTag, CURRENT_COST_BYTE } from '../../src/capsule/enclave-aes/classify/bidx.js'
import { computeBidxTarget } from '../../src/capsule/enclave-aes/classify/find.js'

describe('computeBidxTarget', () => {
  it('target for the right candidate equals the minted tag (round-trip)', async () => {
    const dek = await generateDEK()
    const tag = await mintBidxTag(normalizeForVerify('password', 'hunter2-hunter2'), dek, 'users', 'password')
    const hit = await computeBidxTarget('hunter2-hunter2', 'password', dek, 'users', 'password')
    const miss = await computeBidxTarget('wrong-password!', 'password', dek, 'users', 'password')
    expect(hit).toBe(tag)
    expect(miss).not.toBe(tag)
  }, 30_000)

  it('normalization-equivalence: casefold/whitespace variants → the same target', async () => {
    const dek = await generateDEK()
    const tag = await mintBidxTag(normalizeForVerify('secret-answer', 'Fluffy The Cat'), dek, 'u', 'a')
    expect(await computeBidxTarget('  fluffy   the cat ', 'secret-answer', dek, 'u', 'a')).toBe(tag)
  }, 30_000)

  it('Oracle #4: an unknown/legacy discriminator returns null (no wrong-tier PBKDF2)', async () => {
    const dek = await generateDEK()
    expect(await computeBidxTarget('x', 'password', dek, 'u', 'a', 0x7f)).toBeNull()
  })
})
