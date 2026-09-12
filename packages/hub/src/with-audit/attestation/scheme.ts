import { signBytes, verifyBytes } from '../../capsule/index.js'
import type { SignatureScheme } from './types.js'

/**
 * Attestation signs and verifies with the ENCLAVE's sign group, not with the
 * attestation package's bundled Ed25519 — so a different enclave (Stage B/C)
 * changes what hub signs with, without touching attestation.
 */
export const ENCLAVE_SCHEME: SignatureScheme = { sign: signBytes, verify: verifyBytes }
