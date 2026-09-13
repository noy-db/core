/**
 * Constant-time 32-byte tag comparison.
 *
 * Pure — no WebCrypto, no key material — so it is plumbing rather than a
 * capsule primitive. It lived in `enclave-aes/classify/compare.ts` only
 * because that is where its first caller was; leaving it there would have made
 * `@noy-db/hub/capsule` import the AES capsule to reach it, which is precisely
 * the coupling the seam exists to remove.
 */
/** Compare exactly-32-byte tags. XOR-accumulate over all 32 bytes, no early exit. */
export function ctEqualTags(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) {
    throw new Error(
      `ctEqualTags: tags must be exactly 32 bytes (got ${a.length}/${b.length}) — caller bug; ` +
      `reduce comparands with blindedEqual first`,
    )
  }
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= (a[i]! ^ b[i]!)
  return diff === 0
}
