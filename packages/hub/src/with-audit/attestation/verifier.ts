/**
 * The pure verifier surface, re-exported through hub-owned signatures.
 *
 * `export { … } from '@noy-db/attestation'` would compile fine and bundle
 * fine — but tsc emits that specifier verbatim into hub's `.d.ts`, so a
 * consumer would need `@noy-db/attestation` installed just to TYPECHECK
 * against a package that bundles it. Binding each value to a locally-typed
 * `const` makes the declaration name only `./types.js`.
 * `__tests__/no-runtime-dependencies.test.ts` asserts the emitted `dist`
 * never names the package, and pins these types assignable to attestation's.
 */
import {
  verifyAttestation as _verifyAttestation,
  decodeQr as _decodeQr,
  verifyRevocationList as _verifyRevocationList,
  isRevoked as _isRevoked,
  signRevocationList as _signRevocationList,
} from '@noy-db/attestation'
import type {
  QrPayload,
  RevocationList,
  SignatureScheme,
  VerifyInput,
  VerifyResult,
} from './types.js'

export const verifyAttestation: (
  input: VerifyInput,
  scheme?: SignatureScheme,
) => Promise<VerifyResult> = _verifyAttestation

export const decodeQr: (s: string) => QrPayload = _decodeQr

export const verifyRevocationList: (
  list: RevocationList,
  publicKeyB64: string,
  scheme?: SignatureScheme,
) => Promise<boolean> = _verifyRevocationList

export const isRevoked: (docId: string, list: RevocationList) => boolean = _isRevoked

export const signRevocationList: (
  revokedDocIds: readonly string[],
  asOf: string,
  keyId: string,
  privateKeyPkcs8B64: string,
  scheme?: SignatureScheme,
) => Promise<RevocationList> = _signRevocationList
