/**
 * `@noy-db/hub/on` — the unlock port (the `on-*` family port).
 *
 * ## What this seam is, and what it deliberately is NOT
 *
 * The `on-*` family is **not uniform**, and this subpath does not pretend
 * otherwise. Measured across ten packages (see `check-architecture.mjs`'s
 * `on-family-classification`):
 *
 *   - **one port instance** — `on-shamir` supplies a {@link NoydbShamir} that
 *     hub calls for `profile: 'shamir'` recovery.
 *   - **two slot ceremonies** — `on-password` and `on-webauthn` implement
 *     {@link SlotRewrapCeremony}, which hub calls back during `rotateSecret`
 *     to preserve a tier-2 slot.
 *   - **seven libraries** — `on-totp`, `on-threat`, `on-email-otp` and the
 *     rest. Three import hub zero times, which is the correct amount of
 *     coupling for a TOTP code generator, not a gap to close.
 *
 * So the honest sentence, and the one the docs should carry: **`on-*`
 * packages that hold or rotate a keyring slot implement contracts from here;
 * the rest are freestanding utilities.** A seam is a namespace, not a claim
 * that every package in the family binds it — `/to` already carries two
 * instance types, and nobody reads that as one contract.
 *
 * ## The charter: contracts an unlock method implements AND the API a player calls
 *
 * Both halves, deliberately. A method implementer binds the callback types
 * ({@link SlotRewrapCeremony}) and never drives a ceremony; an unlock *player*
 * — the app running the anti-phishing echo flow — calls
 * {@link beginEchoUnlock} and catches what it throws. Until 0.8.x the echo
 * half lived on the root barrel alone, so a player naming an
 * {@link EchoCeremony} still had to import the whole library to obtain one,
 * and the seam removed nothing.
 *
 * ⛔ Do not re-narrow this to types-only. `/on` held no value export until
 * now, which reads like a rule and was an accident of what the extraction
 * happened to need — `/to` exports four, `/at` two, `/as` and `/by` one each.
 * **A seam a consumer cannot bind alone is not a seam**, so the function and
 * the errors a player catches belong here with the types.
 *
 * ⚠️ The three error classes are re-exported from the root barrel too, and
 * `instanceof` must hold across both. That is exactly the case
 * `tsup.config.ts`'s `splitting: true` protects: shared modules become one
 * chunk with one class definition, so an `EchoCeremonyRequiredError` thrown
 * through `dist/index.js` still matches the class imported from
 * `dist/on/index.js`. Do not "simplify" that build flag.
 *
 * ## Why it exists NOW and did not before
 *
 * `/on` shipped in 0.3.0 and was pruned in 0.4.0 for "zero importers",
 * alongside `/as`, `/at`, `/in` and `/ui`. It was a second place to find types
 * already on the root barrel.
 *
 * What changed is what stands behind it. `@noy-db/ports/on`
 * publishes the ceremony contract as an executable suite, and the symbols it
 * needs are scattered: three live on `/team`, and `KeyringAuthenticator`,
 * `EnclaveKey` and `NoydbShamir` are reachable only from the whole root
 * barrel. A third-party unlock method has to import the entire library to name
 * the five types its ceremony signature uses — which is the coupling this
 * family's seams exist to remove, and the same argument that brought `/at`
 * back.
 *
 * ⚠️ Re-introducing a retired subpath is declared, not incidental: the
 * `unretired` list in `codemods/0.7.0-pre.json` records it, and
 * `codemod-map.test.ts` refuses the claim unless the subpath really resolves.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit.
 */
export type { NoydbShamir } from '../../with-party/team/noydb-shamir.js'
export type {
  SlotRewrapCeremony,
  SlotRewrapContext,
  EnrollAuthenticatorOptions,
} from '../../with-party/team/index.js'
export type { KeyringAuthenticator } from '../../kernel/types.js'
export type { UnlockedKeyring } from '../../with-party/team/keyring.js'
export type { EnclaveKey } from '../../capsule/index.js'
export type { EchoCeremony, BeginEchoUnlockOptions } from '../../with-party/team/echo-ceremony.js'

// The player half. `beginEchoUnlock` is the only way to obtain an
// `EchoCeremony`; without it the two types above would be nameable here and
// unusable here. The three errors are what a player catches to tell
// "re-prompt" from "abandon" — none is reachable by a method implementer who
// never drives the ceremony.
export { beginEchoUnlock } from '../../with-party/team/echo-ceremony.js'
export { EchoCeremonyRequiredError, WrongPromptError, WrongEchoError } from '../../kernel/errors.js'
