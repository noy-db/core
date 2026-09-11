/**
 * Wire-format pins for the Stage A boundary migration (capsule seam spec,
 * Section 4 / Stage A). Each `describe` pins ONE file that used to call
 * `crypto.subtle` directly and now goes through the enclave barrel: an
 * oracle built with raw WebCrypto (tests may) must equal what the migrated
 * code produces, and what the migrated code produces must open under the
 * raw oracle. Tests are added task by task; none may be deleted.
 */
import { describe, it, expect } from 'vitest'

const subtle = globalThis.crypto.subtle

/** Raw AES-256-GCM key with the same attributes `generateDEK` mints. */
export async function rawDek(): Promise<CryptoKey> {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

describe('enclave boundary pins', () => {
  it('scaffold', () => {
    expect(typeof subtle.encrypt).toBe('function')
  })
})
