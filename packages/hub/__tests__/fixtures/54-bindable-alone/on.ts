/**
 * `@noy-db/hub/on`, bound ALONE — BOTH halves of the port's charter (#54).
 *
 * ⛔ One import line, and it must stay one. See `to.ts` for why.
 *
 * ⭐ This is the fixture #54 exists because of. `/on` carries two different
 * kinds of consumer and the defect only ever showed on one of them:
 *
 *   - the METHOD implementer, who supplies a `SlotRewrapCeremony` hub calls
 *     back — this half was bindable alone from the day the subpath shipped;
 *   - the PLAYER, who drives the anti-phishing echo ceremony — this half was
 *     NOT, because `beginEchoUnlock` lived on the root barrel alone until
 *     `ce08de7d` (core#41). Every export check passed throughout: the types
 *     resolved, the goldens were frozen and correct, and the seam was still
 *     unusable because the only way to OBTAIN an `EchoCeremony` was elsewhere.
 */
import {
  beginEchoUnlock,
  EchoCeremonyRequiredError,
  WrongPromptError,
  WrongEchoError,
  type SlotRewrapCeremony,
  type SlotRewrapContext,
  type EnrollAuthenticatorOptions,
  type KeyringAuthenticator,
  type EchoCeremony,
  type UnlockedKeyring,
} from '@noy-db/hub/on'

/**
 * Half one — the method implementer's contract, as `on-password` and
 * `on-webauthn` write it: refuse a slot of another method, then wrap
 * `ctx.newDeks` (never a set captured earlier) and hand back the new slot.
 */
const rewrapFixtureMethod: SlotRewrapCeremony = async (
  ctx: SlotRewrapContext,
): Promise<EnrollAuthenticatorOptions> => {
  const oldSlot: KeyringAuthenticator = ctx.oldSlot
  if (oldSlot.method !== 'password') {
    // The guard the conformance kit's `wrongMethodSlot` case exists to prove.
    throw new Error(`fixture ceremony refuses method "${oldSlot.method}"`)
  }

  return {
    id: oldSlot.id,
    method: 'password',
    meta: { rewrappedDekCount: ctx.newDeks.size },
    wrapKind: 'deks',
    wrapped_deks: 'base64-ciphertext',
    iv: 'base64-iv',
  }
}

/**
 * Half two — the player. The store comes from the caller's own `to-*`
 * package, so it is named through the port's own signature rather than by
 * importing `/to`: a player holds the VALUE already and never needs to name
 * `NoydbStore` itself. That is the honest shape of this call site, not a
 * dodge — and if `beginEchoUnlock` ever stopped being exported here, this
 * line is what stops compiling.
 */
type StoreArg = Parameters<typeof beginEchoUnlock>[0]

export async function unlockAsPlayer(
  store: StoreArg,
  vault: string,
  userId: string,
  prompt: string,
  key: string,
): Promise<UnlockedKeyring | 'phished' | 're-prompt'> {
  let ceremony: EchoCeremony
  try {
    ceremony = await beginEchoUnlock(store, vault, { userId, prompt })
  } catch (err) {
    // The three refusals a player must tell apart. Catching them is the whole
    // reason the error classes belong on this port and not only on the root
    // barrel — a method implementer never sees any of them.
    if (err instanceof WrongPromptError) return 're-prompt'
    if (err instanceof EchoCeremonyRequiredError) return 're-prompt'
    throw err
  }

  // ⛔ The conforming-player obligation, which no conformance kit can observe:
  // when the owner does not recognise `reveal`, the player must warn hard and
  // ABANDON — by never calling `complete()`. Modelled here because the
  // compile-time half (the ceremony's shape) is what this fixture can check.
  if (ceremony.reveal === null && ceremony.maskHint === undefined) return 'phished'

  try {
    return await ceremony.complete({ key })
  } catch (err) {
    if (err instanceof WrongEchoError) return 're-prompt'
    throw err
  }
}

export const exercise = { rewrapFixtureMethod, unlockAsPlayer } as const
