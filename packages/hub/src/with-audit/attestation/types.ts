/**
 * The attestation types, re-exported at their service-layer home.
 *
 * The declarations live in `kernel/attestation-types.ts` because
 * `kernel/vault.ts` names `RevocationList` on its public surface, and the
 * kernel spine may not statically import a `with-*` service (`port-layering`,
 * the S4 gate). This file keeps `./types.js` the natural import for everything
 * inside `with-audit/attestation/`.
 */
export type {
  AttestationFieldSchema,
  QrPayload,
  RevocationList,
  VerifyInput,
  VerifyResult,
  SignatureScheme,
} from '../../kernel/attestation-types.js'
