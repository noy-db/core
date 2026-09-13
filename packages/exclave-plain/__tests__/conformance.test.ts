/**
 * `@noy-db/exclave-plain` against the published conformance kit.
 *
 * This is the run that makes the `exclave-` prefix mean something. The kit
 * asserts the prefix rule FROM THE PACKAGE NAME: a capsule called `exclave-*`
 * must refuse `authenticate` and `seal`, and one called `enclave-*` must
 * support them. Without this run the prefix would be a naming convention; with
 * it, `npm ls` tells an auditor whether a build stores plaintext.
 *
 * The same kit runs against `enclave-aes` inside hub. One definition of the
 * contract, two implementations measured by it — which is the only arrangement
 * where "conforms" means the same thing for both.
 */
import { runCapsuleConformance } from '@noy-db/test-capsule-conformance'
import * as exclave from '../src/index.js'

runCapsuleConformance(exclave as never, { name: '@noy-db/exclave-plain' })
