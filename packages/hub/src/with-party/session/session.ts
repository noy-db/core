/**
 * Session tokens —
 *
 * After a vault is unlocked (via secret, WebAuthn, OIDC, or magic-
 * link), the caller can call `createSession()` to get a session token that
 * allows re-establishing the KEK for the session lifetime without re-running
 * PBKDF2 or any interactive auth challenge.
 *
 * Security model
 * ──────────────
 * A session consists of two pieces that must both be present to recover the
 * KEK:
 *
 *   1. The **session key** — a non-extractable AES-256-GCM CryptoKey that
 *      exists only in memory. "Non-extractable" is enforced by the WebCrypto
 *      API: the key object cannot be serialized, exported, or sent over
 *      postMessage. When the JS context is GC'd (tab close, navigation away,
 *      worker termination) the key becomes unrecoverable.
 *
 *   2. The **session token** — a JSON object that carries the KEK wrapped
 *      with the session key (AES-256-GCM, fresh IV per session), plus
 *      unencrypted session metadata (sessionId, userId, vault, role,
 *      expiresAt). The token can be serialized to JSON and stored in
 *      sessionStorage or passed across callsites within the same tab, but
 *      it is useless without the session key.
 *
 * The session key is kept in a module-level Map indexed by sessionId. Callers
 * that need to re-use a session must hold on to the sessionId returned from
 * `createSession()`; the key is looked up automatically by `resolveSession()`.
 *
 * Revocation: `revokeSession()` removes the entry from the Map. Because the
 * key is non-extractable, removal is sufficient — no one holds a serializable
 * copy of the key.
 *
 * Tab-scoped lifetime: the module-level Map lives only as long as the JS
 * module. Tab close → module unloaded → Map GC'd → all session keys gone.
 * This is the zero-effort logout: closing the tab is always a secure logout.
 *
 * Expiry: `createSession()` accepts a `ttlMs` option. `resolveSession()`
 * checks `expiresAt` and throws `SessionExpiredError` if the token is stale,
 * even if the session key is still in the Map.
 */

import {
  bufferToBase64, base64ToBuffer, exportDekSet, importDekSet,
  generateEphemeralKey, encryptBytes, decryptBytes,
} from '../../kernel/enclave/index.js'
import { generateULID } from '../../with-pod/ulid.js'
import type { Role } from '../../kernel/types.js'
import type { UnlockedKeyring } from '../team/keyring.js'
import { SessionExpiredError, SessionNotFoundError } from '../../kernel/errors.js'


// Default session TTL: 60 minutes
const DEFAULT_TTL_MS = 60 * 60 * 1000

// Module-level session key store. Tab-scoped by construction.
const sessionKeyStore = new Map<string, CryptoKey>()

// ─── Public types ──────────────────────────────────────────────────────

/** The serializable part of a session token. Safe to store in sessionStorage. */
export interface SessionToken {
  readonly _noydb_session: 1
  /** Unique session identifier (ULID). Use this as the handle for resolve/revoke. */
  readonly sessionId: string
  readonly userId: string
  readonly vault: string
  readonly role: Role
  /** ISO timestamp — resolveSession() rejects this token after this time. */
  readonly expiresAt: string
  /** KEK wrapped with the session key (AES-256-GCM). Base64. */
  readonly wrappedKek: string
  /** IV used for the wrapping operation. Base64. */
  readonly kekIv: string
}

/** Result returned from `createSession()`. */
export interface CreateSessionResult {
  /** Serializable token — store in sessionStorage or pass to `resolveSession()`. */
  token: SessionToken
  /** The sessionId — use this handle for `resolveSession()` and `revokeSession()`. */
  sessionId: string
}

/** Options for `createSession()`. */
export interface CreateSessionOptions {
  /**
   * Session lifetime in milliseconds. Defaults to 60 minutes.
   * After this duration, `resolveSession()` throws `SessionExpiredError`.
   */
  ttlMs?: number
}

// ─── Core session operations ───────────────────────────────────────────

/**
 * Create a session for an already-unlocked keyring.
 *
 * Call this after any successful unlock (secret, WebAuthn, OIDC,
 * magic-link). The returned `sessionId` is the handle for later
 * `resolveSession()` and `revokeSession()` calls.
 *
 * The session key is generated fresh (non-extractable) and stored in the
 * module-level Map. The KEK from `keyring.kek` is exported (it must be
 * extractable — it was derived by `deriveKey()` which sets extractable: false,
 * but it's unwrapped from the keyring which sets extractable: true) and then
 * re-wrapped with the session key.
 *
 * @param keyring - An already-unlocked keyring whose `kek` is available.
 * @param vault - The vault name this session is scoped to.
 * @param options - Optional session configuration.
 */
export async function createSession(
  keyring: UnlockedKeyring,
  vault: string,
  options: CreateSessionOptions = {},
): Promise<CreateSessionResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const sessionId = generateULID()
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()

  // Non-extractable — the tab-scope security invariant (see module doc).
  const sessionKey = await generateEphemeralKey()

  // Sessions do not need the KEK (no re-grant, no re-derive during the
  // session lifetime). They need the DEK set, which IS extractable.
  const payload = JSON.stringify({
    userId: keyring.userId,
    displayName: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: await exportDekSet(keyring.deks),
    salt: bufferToBase64(keyring.salt),
  })

  const { iv, data } = await encryptBytes(new TextEncoder().encode(payload), sessionKey)

  const token: SessionToken = {
    _noydb_session: 1,
    sessionId,
    userId: keyring.userId,
    vault,
    role: keyring.role,
    expiresAt,
    wrappedKek: data,
    kekIv: iv,
  }

  sessionKeyStore.set(sessionId, sessionKey)
  return { token, sessionId }
}

/**
 * Resolve a session token back into an UnlockedKeyring.
 *
 * Looks up the session key by `sessionId`, checks the token is not expired,
 * then decrypts the payload to reconstruct the keyring's DEK set.
 *
 * Throws `SessionExpiredError` if the token's `expiresAt` is in the past.
 * Throws `SessionNotFoundError` if the session key is not in the store
 * (tab was reloaded, session was revoked, or the sessionId is wrong).
 *
 * @param token - The SessionToken from `createSession()`.
 */
export async function resolveSession(token: SessionToken): Promise<UnlockedKeyring> {
  // Expiry check first — fast path without touching crypto
  if (Date.now() > new Date(token.expiresAt).getTime()) {
    sessionKeyStore.delete(token.sessionId)
    throw new SessionExpiredError(token.sessionId)
  }

  const sessionKey = sessionKeyStore.get(token.sessionId)
  if (!sessionKey) {
    throw new SessionNotFoundError(token.sessionId)
  }

  let plaintext: Uint8Array
  try {
    plaintext = await decryptBytes(token.kekIv, token.wrappedKek, sessionKey)
  } catch {
    throw new SessionNotFoundError(token.sessionId)
  }

  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
    userId: string
    displayName: string
    role: Role
    permissions: Record<string, 'rw' | 'ro'>
    deks: Record<string, string>
    salt: string
  }

  const deks = await importDekSet(payload.deks)

  return {
    userId: payload.userId,
    displayName: payload.displayName,
    role: payload.role,
    permissions: payload.permissions,
    deks,
    kek: null, // KEK not available in session context
    salt: base64ToBuffer(payload.salt),
    authenticators: [],
  }
}

/**
 * Revoke a session by removing its key from the store.
 *
 * After revocation, `resolveSession()` will throw `SessionNotFoundError`
 * for this sessionId. The session token (if held by the caller) becomes
 * permanently useless. This is the explicit logout path.
 *
 * No-op if the session was already expired or does not exist.
 */
export function revokeSession(sessionId: string): void {
  sessionKeyStore.delete(sessionId)
}

/**
 * Check if a session is still alive (key in store + not expired).
 * Does not decrypt anything — purely a metadata check.
 */
export function isSessionAlive(token: SessionToken): boolean {
  if (Date.now() > new Date(token.expiresAt).getTime()) return false
  return sessionKeyStore.has(token.sessionId)
}

/**
 * Revoke all active sessions. Used by `Noydb.close()` to ensure that
 * closing the instance destroys all session state, not just the keyring
 * cache.
 */
export function revokeAllSessions(): void {
  sessionKeyStore.clear()
}

/**
 * Return the number of active sessions currently in the store.
 * Useful for diagnostics and tests.
 */
export function activeSessionCount(): number {
  return sessionKeyStore.size
}
