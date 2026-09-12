/**
 * #15 — `_iv`/`_data` are optional, and ABSENT must behave exactly like `''`.
 *
 * The widening exists so an *exclave* capsule (Stage C) can store a plaintext
 * row with no ciphertext body at all. Making the fields optional is one line;
 * the work is that every reader must now cope, and the cheap wrong answer is
 * to let `undefined` flow where a `string` used to be. Two of the helpers
 * below did exactly that before this issue:
 *
 *   - `hasSealedBody` asked `env._iv !== ''`, so an omitted `_iv` answered
 *     TRUE — "this has a sealed body" — and the merge authority would then
 *     try to authenticate a body that does not exist.
 *   - `envelopeBodySize` read `.length` off both fields and threw a
 *     `TypeError` rather than metering zero.
 *
 * ⚠️ THE EQUIVALENCE IS THE CONTRACT, and it is not new. A tombstone, a
 * `_del` marker and a plaintext collection have all carried `_iv: ''` since
 * the format's first version. Widening only lets a capsule OMIT the keys
 * instead of emptying them. So every assertion here is written as a PAIR —
 * the `''` envelope and the omitted-key envelope must agree — because the
 * thing being protected is that the two spellings stay indistinguishable to
 * every reader. A test that only checked the omitted case would pass just as
 * well against a build that had quietly changed what `''` means.
 *
 * No wire-format change: `NOYDB_FORMAT_VERSION` does not move, and every
 * envelope already on disk keeps its bytes.
 */
import { describe, it, expect } from 'vitest'
import {
  hasSealedBody,
  envelopeBodySize,
  envelopeBodyForHash,
  openEnvelopeJson,
  verifyRecordIdentity,
  generateDEK,
} from '../src/capsule/enclave-aes/index.js'
import { MissingEnvelopeBodyError } from '../src/kernel/errors.js'
import { NOYDB_FORMAT_VERSION, type Envelope, type EncryptedEnvelope } from '../src/kernel/types.js'

const header = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: '2026-09-12T00:00:00.000Z' } as const

/** Today's spelling of "no sealed body": the keys are present and empty. */
const emptied: Envelope = { ...header, _iv: '', _data: '' }
/** The exclave's spelling of the same thing: the keys are absent. */
const omitted: Envelope = { ...header }

describe('#15 — an omitted body is the same thing as an empty one', () => {
  it('hasSealedBody() answers false for both spellings', () => {
    expect(hasSealedBody(emptied)).toBe(false)
    expect(hasSealedBody(omitted)).toBe(false)
  })

  it('still answers true when there IS a body — the control', () => {
    // Without this row the two assertions above would pass against a
    // `hasSealedBody` that had been "fixed" to `return false`.
    const sealed: Envelope = { ...header, _iv: 'aXY=', _data: 'Zm9v' }
    expect(hasSealedBody(sealed)).toBe(true)
  })

  it('envelopeBodySize() meters both spellings as 0, and a real body by length', () => {
    expect(envelopeBodySize(emptied)).toBe(0)
    expect(envelopeBodySize(omitted)).toBe(0)
    expect(envelopeBodySize({ ...header, _iv: 'aXY=', _data: 'Zm9v' } as Envelope)).toBe(8)
  })

  it('envelopeBodyForHash() derives the same bytes for both spellings', () => {
    // Load-bearing: this feeds the audit ledger hash chain. If an omitted
    // body hashed differently from an empty one, every pre-existing ledger
    // entry would stop verifying the moment a capsule switched spelling.
    expect(envelopeBodyForHash(omitted)).toBe(envelopeBodyForHash(emptied))
    expect(envelopeBodyForHash(omitted)).toBe('')
  })

  it('verifyRecordIdentity() treats both spellings as vacuously authentic', async () => {
    const key = await generateDEK()
    const ref = { collection: 'rows', id: 'r1' }
    expect(await verifyRecordIdentity(ref, emptied, key)).toBe(true)
    expect(await verifyRecordIdentity(ref, omitted, key)).toBe(true)
  })

  it('openEnvelopeJson() refuses a bodyless envelope with a typed error, not a TypeError', async () => {
    const key = await generateDEK()
    const ref = { collection: 'rows', id: 'r1' }
    // An AES capsule cannot open what is not there. It must say so in its own
    // vocabulary — NOT as TamperedError, which is hub's security alert for
    // "the AEAD tag did not verify" and would read as an attack.
    await expect(openEnvelopeJson(ref, omitted, key)).rejects.toThrow(MissingEnvelopeBodyError)
  })

  it('the plaintext path returns "" for both spellings rather than undefined', async () => {
    const key = await generateDEK()
    const ref = { collection: 'rows', id: 'r1' }
    expect(await openEnvelopeJson(ref, emptied, key, { encrypted: false })).toBe('')
    expect(await openEnvelopeJson(ref, omitted, key, { encrypted: false })).toBe('')
  })
})

describe('#15 — EncryptedEnvelope is an alias, not a narrower type', () => {
  it('accepts a bodyless envelope under the old name too', () => {
    // If `EncryptedEnvelope` had been declared as a body-REQUIRED subtype,
    // this line would not compile — and hub's 43 reader files would have kept
    // compiling untouched while being wrong at runtime for an exclave row.
    const underOldName: EncryptedEnvelope = omitted
    expect(hasSealedBody(underOldName)).toBe(false)
  })
})
