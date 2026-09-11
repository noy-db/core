/**
 * Hub-owned copies of the attestation types. `@noy-db/attestation` is
 * BUNDLED into hub (tsup `noExternal`), so hub's emitted `.d.ts` must not
 * name the package — a consumer would otherwise need it installed to
 * typecheck. The shapes are structurally identical; the `_Pins` block in
 * `__tests__/no-runtime-dependencies.test.ts` asserts mutual assignability,
 * so drift fails typecheck rather than surfacing at a consumer.
 */
export type Normalizer = 'trim' | 'lower' | 'upper' | 'alnum-upper' | 'digits' | 'cents' | 'iso-date'

export interface AttestationFieldSpec {
  readonly path: string
  readonly normalize: Normalizer
}

export interface AttestationFieldSchema {
  readonly fields: readonly AttestationFieldSpec[]
}

export interface QrPayload {
  readonly v: 1
  readonly docId: string
  readonly salt: string
  readonly alg: 'ed25519'
  readonly keyId: string
  readonly fieldHashes: readonly string[]
  readonly sig: string
}

export interface RevocationList {
  readonly v: 1
  readonly revokedDocIds: readonly string[]
  readonly asOf: string
  readonly keyId: string
  readonly sig: string
}

export interface VerifyInput {
  readonly qr: string
  readonly claimedFields: Record<string, unknown>
  readonly fieldSchema: AttestationFieldSchema
  readonly publicKeys: Readonly<Record<string, string>>
  readonly revocation?: { list: RevocationList }
}

export interface VerifyResult {
  readonly valid: boolean
  readonly signatureValid: boolean
  readonly perField: ReadonlyArray<{ path: string; match: boolean }>
  readonly revoked: boolean | null
  readonly reason?: string
}

/**
 * The signature primitive attestation signs and verifies with. Hub declares
 * its own copy for the same reason as the rest of this file: `ENCLAVE_SCHEME`
 * is typed by it, so naming attestation here would put the package back in
 * hub's `.d.ts`.
 */
export interface SignatureScheme {
  sign(privateKeyPkcs8B64: string, message: Uint8Array): Promise<string>
  verify(publicKeyB64: string, sigB64url: string, message: Uint8Array): Promise<boolean>
}
