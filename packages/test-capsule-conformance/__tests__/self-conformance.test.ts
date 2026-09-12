/**
 * `enclave-aes` passes its own conformance suite.
 *
 * This is the baseline that makes the suite mean anything for anyone else: a
 * conformance suite the REFERENCE implementation does not pass is measuring
 * the suite's assumptions rather than the contract. It also keeps the two in
 * step — a primitive whose behaviour changes breaks here first, in the repo
 * that owns it, rather than in a downstream capsule author's CI.
 */
import { runCapsuleConformance, type CapsuleUnderTest } from '../src/index.js'
import * as capsule from '../../hub/src/capsule/index.js'

runCapsuleConformance(capsule as unknown as CapsuleUnderTest, {
  // The CAPSULE's name, not hub's. The prefix rule is a claim about the
  // implementation's trust posture — `enclave-` means it holds secrets — and
  // hub is merely where this one happens to ship. A capsule in its own package
  // passes that package's name (`@noy-db/exclave-plain`).
  name: 'enclave-aes',
})
