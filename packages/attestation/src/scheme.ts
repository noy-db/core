import { ed25519Sign, ed25519Verify } from './ed25519.js'

/**
 * The signature primitive attestation signs and verifies with. Ed25519 is the
 * default and the only algorithm `v:1` payloads name; a caller with its own
 * engine (noy-db's enclave, a post-quantum fork) injects one with the same
 * shape. If a second algorithm is ever named in a payload, `alg` must join
 * the signed core (see `verify.ts` `signedCore`).
 */
export interface SignatureScheme {
  sign(privateKeyPkcs8B64: string, message: Uint8Array): Promise<string>
  verify(publicKeyB64: string, sigB64url: string, message: Uint8Array): Promise<boolean>
}

export const ed25519Scheme: SignatureScheme = { sign: ed25519Sign, verify: ed25519Verify }
