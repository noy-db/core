/**
 * THE DOOR. This is the ONLY hub file that may import the bound capsule.
 * Everything else in hub imports THIS file.
 *
 * Enforced by `capsule-door-only` in `scripts/check-architecture.mjs`. A door
 * nothing enforces is not a door — it is a suggestion, and the enclave barrel
 * it replaces was reached around 38 times before a check existed.
 *
 * ⚠️ At this point in Stage B the door re-exports today's enclave barrel
 * directly. Task 3 repoints it at `#capsule`, which resolves to
 * `capsule/enclave-aes/` by default and to an alternative package under a
 * consumer's build condition. The indirection lands BEFORE the directory moves
 * so that when ~223 files change path, the door is the one thing already known
 * to work.
 */
export * from '../kernel/enclave/index.js'

export type { CapsuleKey, CapsuleKeyPair, CapsuleGroup } from './contract.js'
export { CapsuleNotSupportedError } from './contract.js'
