/**
 * Wire-format pins for the Stage A boundary migration (capsule seam spec,
 * Section 4 / Stage A). Each `describe` pins ONE file that used to call
 * `crypto.subtle` directly and now goes through the enclave barrel: an
 * oracle built with raw WebCrypto (tests may) must equal what the migrated
 * code produces, and what the migrated code produces must open under the
 * raw oracle. Tests are added task by task; none may be deleted.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  enableDevUnlock,
  loadDevUnlock,
  clearDevUnlock,
} from '../src/with-party/session/dev-unlock.js'
import type { UnlockedKeyring } from '../src/with-party/team/keyring.js'
import {
  generateEphemeralKey,
  encryptBytes,
  decryptBytes,
  bufferToBase64,
  base64ToBuffer,
} from '../src/kernel/enclave/index.js'
import {
  createSession,
  resolveSession,
  revokeAllSessions,
} from '../src/with-party/session/session.js'
import { SessionNotFoundError } from '../src/kernel/errors.js'

const subtle = globalThis.crypto.subtle

/** Raw AES-256-GCM key with the same attributes `generateDEK` mints. */
export async function rawDek(): Promise<CryptoKey> {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/** base64 of a key's raw bytes, built with WebCrypto directly — the oracle. */
async function rawBase64(key: CryptoKey): Promise<string> {
  return btoa(String.fromCharCode(...new Uint8Array(await subtle.exportKey('raw', key))))
}

describe('enclave boundary pins', () => {
  it('scaffold', () => {
    expect(typeof subtle.encrypt).toBe('function')
  })
})

// ─── Task 1: dev-unlock.ts ────────────────────────────────────────────────────

// The acknowledge string is deliberately duplicated here rather than imported:
// the module keeps it private precisely so it must appear verbatim in caller
// source, and a pin that imported it could not catch the constant changing.
const ACK = 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY'

describe('dev-unlock — DEK payload is the exportDekSet shape', () => {
  afterEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('persists { collection: base64(raw DEK) } and round-trips through loadDevUnlock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dek = await rawDek()
    const keyring = {
      userId: 'alice',
      displayName: 'Alice',
      role: 'owner',
      permissions: { invoices: 'rw' },
      deks: new Map([['invoices', dek]]),
      kek: null,
      salt: new Uint8Array(32).fill(7),
      authenticators: [],
    } as unknown as UnlockedKeyring

    await enableDevUnlock('v', 'alice', keyring, { acknowledge: ACK })

    const stored = JSON.parse(sessionStorage.getItem('noydb:dev-unlock:v:alice')!) as {
      deks: Record<string, string>
    }
    expect(stored.deks).toEqual({ invoices: await rawBase64(dek) })

    const back = await loadDevUnlock('v', 'alice')
    expect(await rawBase64(back!.deks.get('invoices')!)).toBe(await rawBase64(dek))

    clearDevUnlock('v', 'alice')
    expect(sessionStorage.getItem('noydb:dev-unlock:v:alice')).toBeNull()
  })
})

// ─── Task 2: session.ts ───────────────────────────────────────────────────────

describe('generateEphemeralKey', () => {
  it('mints a NON-extractable AES-GCM key that encryptBytes/decryptBytes accept', async () => {
    const k = await generateEphemeralKey()
    expect(k.extractable).toBe(false)
    expect(k.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    const { iv, data } = await encryptBytes(new TextEncoder().encode('x'), k)
    expect(new TextDecoder().decode(await decryptBytes(iv, data, k))).toBe('x')
    await expect(subtle.exportKey('raw', k)).rejects.toThrow()
  })
})

describe('session — token payload is AES-GCM(iv, JSON{deks: exportDekSet}) under the session key', () => {
  it('round-trips and carries base64(raw DEK) per collection', async () => {
    const dek = await rawDek()
    const keyring = {
      userId: 'alice',
      displayName: 'Alice',
      role: 'owner',
      permissions: {},
      deks: new Map([['invoices', dek]]),
      kek: null,
      salt: new Uint8Array(32).fill(1),
      authenticators: [],
    } as unknown as UnlockedKeyring
    try {
      const { token } = await createSession(keyring, 'v')
      expect(typeof token.wrappedKek).toBe('string')
      expect(typeof token.kekIv).toBe('string')

      const back = await resolveSession(token)
      expect(await rawBase64(back.deks.get('invoices')!)).toBe(await rawBase64(dek))
      expect(back.kek).toBeNull()
    } finally {
      revokeAllSessions()
    }
  })

  it('still throws SessionNotFoundError — not TamperedError — when the payload is corrupt', async () => {
    const keyring = {
      userId: 'alice',
      displayName: 'Alice',
      role: 'owner',
      permissions: {},
      deks: new Map([['invoices', await rawDek()]]),
      kek: null,
      salt: new Uint8Array(32).fill(1),
      authenticators: [],
    } as unknown as UnlockedKeyring
    try {
      const { token } = await createSession(keyring, 'v')
      const bytes = base64ToBuffer(token.wrappedKek)
      bytes.set([bytes[0]! ^ 0xff], 0)
      const tampered = { ...token, wrappedKek: bufferToBase64(bytes) }
      await expect(resolveSession(tampered)).rejects.toBeInstanceOf(SessionNotFoundError)
    } finally {
      revokeAllSessions()
    }
  })
})
