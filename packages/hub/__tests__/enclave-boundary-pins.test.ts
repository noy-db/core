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
  importTransferKey,
  mintCanary,
  checkCanary,
  deriveKey,
  generateSalt,
} from '../src/kernel/enclave/index.js'
import { sealDeks } from '../src/with-cargo/extract-partition.js'
import { unsealDeks } from '../src/with-cargo/adopt-partition.js'
import {
  createSession,
  resolveSession,
  revokeAllSessions,
} from '../src/with-party/session/session.js'
import {
  SessionNotFoundError,
  NoydbError,
  ValidationError,
  TransferSealError,
} from '../src/kernel/errors.js'
import { MemoryDeviceSeal } from '../src/with-party/team/device-seal.js'
import {
  buildEchoBlock,
  verifyPrompt,
  resolveEchoReveal,
} from '../src/with-party/team/echo-secret.js'
import { WrongPromptError } from '../src/kernel/errors.js'

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

// ─── Task 3: device-seal.ts ───────────────────────────────────────────────────

describe('MemoryDeviceSeal — iv(12) ‖ AES-GCM ct', () => {
  it('seals to 12 + len + 16 bytes, unseals, and rejects a flipped byte with DEVICE_SEAL_UNSEAL_FAILED', async () => {
    const seal = new MemoryDeviceSeal({ id: 'dev-1' })
    const plain = new TextEncoder().encode('echo')
    const sealed = await seal.seal(plain)
    expect(sealed.byteLength).toBe(12 + plain.byteLength + 16)
    expect(await seal.unseal(sealed)).toEqual(plain)

    const bad = sealed.slice()
    bad.set([bad[20]! ^ 0x01], 20)
    const err = await seal.unseal(bad).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NoydbError)
    expect((err as NoydbError).code).toBe('DEVICE_SEAL_UNSEAL_FAILED')
  })
})

// ─── Task 4: partition transfer seal ──────────────────────────────────────────

describe('importTransferKey', () => {
  it('imports 32 raw bytes as a non-extractable AES-GCM key and refuses any other length', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const k = await importTransferKey(raw)
    expect(k.extractable).toBe(false)
    const { iv, data } = await encryptBytes(new Uint8Array([1, 2, 3]), k)
    // oracle: the same raw bytes under raw WebCrypto open it
    const ok = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuffer(iv) }, ok, base64ToBuffer(data))
    expect(new Uint8Array(pt)).toEqual(new Uint8Array([1, 2, 3]))
    await expect(importTransferKey(new Uint8Array(16))).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('transfer seal — iv ‖ AES-GCM(JSON{collection: base64 rawDEK}) under a 32-byte key', () => {
  it('opens under raw WebCrypto with the returned transfer key, round-trips, and a wrong key is TransferSealError', async () => {
    const dek = await rawDek()
    const { seal, transferKey } = await sealDeks(new Map([['invoices', dek]]))
    expect(seal.alg).toBe('aes-256-gcm-pre-shared')

    const combined = base64ToBuffer(seal.payload)
    const k = await subtle.importKey('raw', transferKey as BufferSource, 'AES-GCM', false, ['decrypt'])
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12) }, k, combined.slice(12))
    const map = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>
    expect(map.invoices).toBe(await rawBase64(dek))

    const back = await unsealDeks(seal, transferKey)
    expect(await rawBase64(back.get('invoices')!)).toBe(await rawBase64(dek))

    const wrong = crypto.getRandomValues(new Uint8Array(32))
    await expect(unsealDeks(seal, wrong)).rejects.toBeInstanceOf(TransferSealError)
    await expect(unsealDeks(seal, new Uint8Array(16))).rejects.toBeInstanceOf(TransferSealError)
  })
})

// ─── Task 5: keyring canary + echo verifiers ──────────────────────────────────

describe('mintCanary / checkCanary', () => {
  it('is deterministic per (kek, plaintext), equals raw AES-KW of the imported constant, and checks false under another KEK', async () => {
    const salt = generateSalt()
    const kek = await deriveKey('pw', salt)
    const zeros = new Uint8Array(32)
    const a = await mintCanary(kek, zeros)
    expect(await mintCanary(kek, zeros)).toBe(a)

    // oracle: raw AES-KW wrap of the same constant under a raw-derived KEK
    const k = await subtle.importKey('raw', zeros, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const kekRaw = await subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations: 600_000, hash: 'SHA-256' },
      await subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey']),
      { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey'],
    )
    const wrapped = new Uint8Array(await subtle.wrapKey('raw', k, kekRaw, 'AES-KW'))
    expect(base64ToBuffer(a)).toEqual(wrapped)

    expect(await checkCanary(a, kek)).toBe(true)
    expect(await checkCanary(a, await deriveKey('other', salt))).toBe(false)
    expect(await checkCanary('not base64!!', kek)).toBe(false)
  }, 30_000)
})

describe('echo block — verifiers are AES-KW canaries; portable reveal is AES-GCM under the prompt', () => {
  it('verifies the right prompt, reveals the echo, and a wrong prompt is WrongPromptError', async () => {
    const parts = { prompt: 'what colour', echo: 'blue', key: 'k' }
    const block = await buildEchoBlock(parts, { kind: 'portable' })
    expect(await verifyPrompt(block, 'what colour')).toBe(true)
    expect(await verifyPrompt(block, 'nope')).toBe(false)
    expect(await resolveEchoReveal(block, 'what colour')).toBe('blue')
    await expect(resolveEchoReveal(block, 'nope')).rejects.toBeInstanceOf(WrongPromptError)

    // oracle: the portable blob opens under raw WebCrypto with the prompt-derived key
    if (block.reveal.kind !== 'portable') throw new Error('unreachable')
    const gcm = await subtle.deriveKey(
      { name: 'PBKDF2', salt: base64ToBuffer(block.reveal.salt), iterations: 600_000, hash: 'SHA-256' },
      await subtle.importKey('raw', new TextEncoder().encode('what colour'), 'PBKDF2', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    )
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(block.reveal.iv) },
      gcm,
      base64ToBuffer(block.reveal.blob),
    )
    expect(new TextDecoder().decode(pt)).toBe('blue')
  }, 60_000)
})
