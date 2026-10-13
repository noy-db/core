/**
 * `exportMyAccessibleData`: a non-owner user exports the scope they
 * can decrypt as a portable, re-keyed `.noydb` bundle. Non-destructive and
 * **always allowed** (the "data sovereignty by construction" property of
 * sealing-at-dimension — the firm cannot deny it) but **audited**.
 *
 * Reuses the existing bundle machinery: the access boundary is the caller's DEK
 * set (operator/client → `keyring.permissions`; owner/admin/viewer → all), so a
 * record outside the caller's keys can never enter the bundle. Re-keying to a
 * new owner reuses `writePod`'s `exportSecret` shorthand.
 */
import type { Vault } from '../../kernel/vault.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import { writePod } from '../../with-pod/pod.js'

/**
 * Resolve the collections a caller may export/withdraw: operator/client are
 * scoped to their granted collections; owner/admin/viewer see everything
 * (`undefined` = no allowlist). A `scope.collections` sub-scope intersects the
 * granted set. `writableOnly` keeps only `rw` grants (for destructive ops).
 */
export function resolveAccessibleCollections(
  keyring: UnlockedKeyring,
  scope: { collections?: readonly string[] } | undefined,
  writableOnly = false,
): string[] | undefined {
  let collections: string[] | undefined
  if (keyring.role === 'operator' || keyring.role === 'client') {
    collections = Object.entries(keyring.permissions)
      .filter(([, mode]) => !writableOnly || mode === 'rw')
      .map(([c]) => c)
  }
  if (scope?.collections) {
    const allow = new Set(scope.collections)
    collections = (collections ?? [...scope.collections]).filter((c) => allow.has(c))
  }
  return collections
}

/** Produce a (optionally re-keyed, scoped) `.noydb` bundle — no audit. */
export async function buildAccessibleBundle(
  vault: Vault,
  collections: string[] | undefined,
  reKey: { secret: string } | undefined,
  compression: 'auto' | 'brotli' | 'gzip' | 'none' = 'auto',
): Promise<Uint8Array> {
  return writePod(vault, {
    compression,
    ...(collections !== undefined ? { collections } : {}),
    ...(reKey ? { exportSecret: reKey.secret } : {}),
  })
}

export interface ExportAccessibleOptions {
  /**
   * Re-key the bundle so it is independently openable by a new owner with this
   * secret (the receiving firm / the client themselves). Omit to inherit
   * the source keyring (personal backup).
   */
  readonly reKey?: { readonly secret: string }
  /** Narrow the export to a subset of the caller's accessible collections. */
  readonly scope?: { readonly collections?: readonly string[] }
  readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
}

/**
 * Produce a re-keyed, access-scoped `.noydb` bundle of the caller's accessible
 * data. Appends a tamper-evident audit entry (`reason: 'user-export:<userId>'`)
 * BEFORE building, so a build that fails part-way still records the access it
 * already made (family#175).
 */
export async function exportAccessibleData(
  vault: Vault,
  opts: ExportAccessibleOptions = {},
): Promise<Uint8Array> {
  const { keyring } = vault._introspectState()
  const collections = resolveAccessibleCollections(keyring, opts.scope)

  // §11.11 audit — non-destructive, always-allowed export. No-op when the vault
  // has no history/ledger strategy (avoids minting a phantom _ledger DEK).
  //
  // ⚠️ BEFORE THE BUILD, since family#175. It used to come after, which
  // under-recorded the case an audit reader cares about most: a build that
  // throws part-way has already READ the caller's accessible collections, and
  // with `reKey` it has decrypted them in-process to re-encrypt under the
  // export secret. A failure does not un-read them, so an entry written only
  // on success reports "no export" for an access that happened.
  //
  // ⛔ THE REASON STRING IS UNCHANGED, deliberately. A consumer greps
  // `user-export:` out of the ledger, so the entry's MEANING moves from
  // "completed" to "attempted" while its shape does not. For a trail of data
  // ACCESS that is the stronger reading of the same event — the same argument
  // family#151 made for `exportWith`, where the plaintext chunks exist before
  // `encode` runs.
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle',
    collection: '',
    id: '',
    version: 0,
    actor: keyring.userId,
    payloadHash: '',
    reason: `user-export:${keyring.userId}`,
  })

  return await buildAccessibleBundle(vault, collections, opts.reKey, opts.compression ?? 'auto')
}
