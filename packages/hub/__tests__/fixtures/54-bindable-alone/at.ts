/**
 * `@noy-db/hub/at`, bound ALONE — a sealing-key provider's whole import list (#54).
 *
 * ⛔ One import line, and it must stay one. See `to.ts` for why.
 *
 * ⚠️ `at-*` is the family's one NON-zero-knowledge layer, so "the author can
 * write this against the port alone" matters more here than anywhere: a
 * provider reaching for the root barrel to name a type is a provider reading
 * hub internals it has no business seeing.
 */
import {
  MemorySealer,
  MemoryRecipientSealer,
  parseSealedEnvelope,
  SEALED_SECRET_RECORD_ID,
  type NoydbSealer,
  type SealedSecret,
} from '@noy-db/hub/at'

/** The contract an `at-*` package implements, written against the port alone. */
class EchoingSealer implements NoydbSealer {
  readonly id: string

  constructor(opts: { id: string }) {
    this.id = opts.id
  }

  async seal(secret: Uint8Array): Promise<Uint8Array> {
    // A real provider hands these bytes to a host key; the shape is the point.
    return Uint8Array.from(secret, b => b ^ 0x5a)
  }

  async unseal(sealed: Uint8Array): Promise<Uint8Array> {
    return Uint8Array.from(sealed, b => b ^ 0x5a)
  }
}

/**
 * The caller half: seal through the shipped reference provider, then parse a
 * persisted envelope back — the round trip a provider author runs to check
 * their own implementation against hub's.
 */
export async function exercise(): Promise<readonly [boolean, string, SealedSecret | undefined]> {
  const reference = new MemorySealer({ id: 'memory:fixture' })
  const mine: NoydbSealer = new EchoingSealer({ id: 'echo:fixture' })

  const secret = new Uint8Array([1, 2, 3, 4])
  const sealed = await reference.seal(secret)
  const opened = await reference.unseal(sealed)
  const mineRoundTripped = await mine.unseal(await mine.seal(secret))

  const matches =
    opened.length === secret.length && mineRoundTripped.length === secret.length

  // Recipient sealing is the other half of this port, and a provider that
  // supports it must be able to name it from here too.
  const recipients = new MemoryRecipientSealer({ id: 'memory-recipient:fixture' })

  const parsed = parseSealedEnvelope({
    v: 1,
    _noydb_sealed: 1,
    pid: reference.id,
    payload: 'AAAA',
  })

  return [matches && recipients !== undefined, SEALED_SECRET_RECORD_ID, parsed] as const
}
