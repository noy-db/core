/**
 * core#56 — `writeMagicLinkGrant({ collection: undefined })` refuses HONESTLY.
 *
 * ⚠️ HALF OF THIS FILE'S ORIGINAL PREMISE IS GONE, deliberately.
 * `issueDelegation` no longer refuses the collection-wide form: it now issues a
 * MULTI-DEK token (one wrapped DEK per collection) and the read half merges
 * them under their real slots. That case moved to
 * `delegation-read-half.test.ts`, which asserts it SUCCEEDS. What is left here
 * is the magic-link path, which genuinely cannot express the shape.
 *
 * ## What was measured, and how
 *
 * `issueDelegation` and `writeMagicLinkGrant` both accept an optional
 * `collection`, and both are documented as meaning "every collection" when it
 * is omitted. Neither has ever worked:
 *
 *  - `writeMagicLinkGrant` looks up `__any#<tier>` in the grantor's keyring.
 *    The ONLY writer of that key anywhere in the tree is
 *    `loadActiveDelegations`, which is called by nothing (core#56). So the key
 *    never exists, for any caller, ever.
 *  - `issueDelegation` did not even attempt the lookup — it forced
 *    `sourceDek = undefined` whenever `collection` was absent.
 *
 * Both then threw `DelegationTargetMissingError` **with a sentence in the
 * `toUser` slot**, rendering as:
 *
 *     Delegation target user "grantor cannot find tier 1 DEK for (any)"
 *     has no keyring in this vault
 *
 * — a target user that is not a user, and a cause that is not the cause. The
 * real consumer is `@noy-db/on-magic-link`'s `issueMagicLinkDelegation()` in
 * the `on` repo, so the message is the only thing telling them which side of
 * the seam the fault is on.
 *
 * ## What this test does and does not assert
 *
 * ⛔ It does NOT assert the feature works — it does not. It pins the refusal:
 * the right error, a real `toUser`, and a message naming the actual cause.
 * ⭐ Every case carries a SCOPED CONTROL that gets past the same lookup, so a
 * failure here cannot be "grants are broken generally" — it is specific to the
 * collection-wide branch.
 *
 * ⚠️ When the read half lands, these expectations must change deliberately,
 * not be deleted: the branch should start SUCCEEDING.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, DelegationTargetMissingError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { generateDEK } from '../src/capsule/enclave-aes/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

function memoryStore(): NoydbStore {
  const d = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = d.get(v); if (!vm) { vm = new Map(); d.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return d.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, e, ev) {
      const co = gc(v, c); const ex = co.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      co.set(id, e)
    },
    async delete(v, c, id) { d.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(d.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = d.get(v); const s: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [i, e] of cm) r[i] = e
        s[cn] = r
      }
      return s
    },
    async saveAll() {},
  }
}

async function freshVault() {
  const db = await createNoydb({
    store: memoryStore(), secret: 'pw', user: 'owner',
    tiersStrategy: withTiers(), teamStrategy: withTeam(),
  })
  const vault = await db.openVault('v1')
  const docs = vault.collection<{ id: string; t: string }>('docs', { tiers: [0, 1] })
  await docs.putAtTier('a', { id: 'a', t: 'x' }, 1)
  return { db, vault }
}

const until = (): string => new Date(Date.now() + 60_000).toISOString()

describe('core#56 — collection-wide grants refuse honestly', () => {
  it('no `__any#` slot exists anywhere — the wildcard is gone for good', async () => {
    const { vault } = await freshVault()
    const keys = [...(vault as unknown as { keyring: { deks: Map<string, unknown> } }).keyring.deks.keys()]
    expect(keys).toContain('docs#1')
    expect(keys.some((k) => k.startsWith('__any#'))).toBe(false)
  })

  it('writeMagicLinkGrant without a collection names the unimplemented branch', async () => {
    const { vault } = await freshVault()
    const ck = await generateDEK()
    const kek = await generateDEK()

    const err = await vault.writeMagicLinkGrant(ck as never, kek as never, 'rid-any', {
      toUser: 'bob', tier: 1, until: until(),
    } as never).then(() => null, (e: unknown) => e as DelegationTargetMissingError)

    expect(err).toBeInstanceOf(DelegationTargetMissingError)
    expect(err?.toUser).toBe('bob')
    // ⭐ The reason is now SPECIFIC to this function rather than shared: a
    // magic-link record carries a single wrapped DEK, and "every collection"
    // needs one per collection because each has its own tier DEK.
    expect(err?.message).toMatch(/single wrapped DEK/)
    expect(err?.message).toMatch(/each\s+collection has its own tier-1 DEK/)
    expect(err?.message).not.toMatch(/__any#/)
  })

  it('a grantor missing the per-collection DEK gets a DIFFERENT, accurate message', async () => {
    const { vault } = await freshVault()

    const err = await vault.delegate({
      toUser: 'owner', tier: 2, collection: 'docs', until: until(),
    }).then(() => null, (e: unknown) => e as DelegationTargetMissingError)

    expect(err).toBeInstanceOf(DelegationTargetMissingError)
    expect(err?.message).toMatch(/holds no tier-2 DEK for collection "docs"/)
    // ⭐ Must NOT claim the unimplemented branch — that is the confusion this fixes.
    expect(err?.message).not.toMatch(/not implemented/)
  })
})
