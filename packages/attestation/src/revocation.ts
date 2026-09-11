import { canonicalJson, utf8 } from './encoding.js'
import { ed25519Scheme, type SignatureScheme } from './scheme.js'

export interface RevocationList {
  readonly v: 1
  readonly revokedDocIds: readonly string[]
  readonly asOf: string
  readonly keyId: string
  readonly sig: string
}

function listCore(revokedDocIds: readonly string[], asOf: string, keyId: string): Uint8Array {
  return utf8(canonicalJson({ v: 1, revokedDocIds: [...revokedDocIds].sort(), asOf, keyId }))
}

export function isRevoked(docId: string, list: RevocationList): boolean {
  // The list is untrusted (typically network-fetched). Fail closed on a
  // malformed shape rather than throwing a raw TypeError.
  if (!Array.isArray(list?.revokedDocIds)) return false
  return list.revokedDocIds.includes(docId)
}

export async function signRevocationList(
  revokedDocIds: readonly string[], asOf: string, keyId: string, privateKeyPkcs8B64: string,
  scheme: SignatureScheme = ed25519Scheme,
): Promise<RevocationList> {
  const sorted = [...revokedDocIds].sort()
  const sig = await scheme.sign(privateKeyPkcs8B64, listCore(sorted, asOf, keyId))
  return { v: 1, revokedDocIds: sorted, asOf, keyId, sig }
}

export async function verifyRevocationList(
  list: RevocationList,
  publicKeyB64: string,
  scheme: SignatureScheme = ed25519Scheme,
): Promise<boolean> {
  // Untrusted input — validate the shape before touching it (no raw TypeError).
  if (list?.v !== 1 || !Array.isArray(list.revokedDocIds)
      || typeof list.asOf !== 'string' || typeof list.keyId !== 'string' || typeof list.sig !== 'string') {
    return false
  }
  return scheme.verify(publicKeyB64, list.sig, listCore(list.revokedDocIds, list.asOf, list.keyId))
}
