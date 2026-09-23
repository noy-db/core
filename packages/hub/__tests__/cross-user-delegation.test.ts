/**
 * core#65 — a delegation to a user whose secret the grantor does not know.
 *
 * `delegate()` wrapped the delegated tier DEK against the GRANTOR's own KEK, so
 * a token addressed to anybody else could not be unwrapped by them: the read
 * half reached it, failed, and skipped — silently and correctly. What worked
 * was self-delegation, or a target sharing the issuing KEK.
 *
 * The exchange it was waiting for arrived as core#96's INBOX KEY PAIR. A token
 * now carries a per-token content key, RSA-OAEP-sealed to the target's public
 * half; the tier DEKs are AES-KW-wrapped under that key exactly as they used to
 * be under a KEK. The slot NAMES stay readable to any member holding the
 * `_delegations` DEK — an audit can enumerate what was delegated to whom
 * without being able to use any of it.
 *
 * ⭐ THE FIRST CASE IS THE REGRESSION PROPERTY FOR THIS WHOLE CLASS, and its
 * controls are what make it one. The defect it pins — the same shape core#56
 * removed from the magic-link path — is a write that SUCCEEDS and produces
 * something the intended reader cannot open, which no assertion on the
 * grantor's side can see. So the target reads from HIS OWN session under HIS
 * OWN secret, never the grantor's; the tier is proven closed to him first; and
 * the second case supplies the negative control, a member who holds the
 * `_delegations` DEK and still cannot open the token. Remove either control and
 * the row can pass while `delegate()` is silently useless again.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, MemberInboxMissingError, DelegationTargetMissingError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { parseKeyringEnvelope, requireRosterKey } from '../src/with-party/team/keyring.js'
import { mintRosterTag, stampAuthority } from '../src/with-party/team/roster-tag.js'
import { INBOX_KEY_ID } from '../src/kernel/constants.js'
import type { NoydbStore, KeyringFile } from '../src/kernel/types.js'
import type { Vault } from '../src/kernel/vault.js'

interface Doc { id: string; body: string }
const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
const soon = (): string => new Date(Date.now() + 60_000).toISOString()

function open(store: NoydbStore, user: string, secret: string) {
  return createNoydb({ store, user, secret, validateSecret: false, tiersStrategy: withTiers(), teamStrategy: withTeam() })
}
const docsOf = (v: Vault) => v.collection<Doc>('docs', { tiers: [0, 1] })
/** `getAtTier` widens to `Doc | GhostRecord` — a ghost has no `body`, which is exactly the "closed" case these assertions read. */
const bodyAtTier = async (v: Vault, id: string): Promise<string | undefined> => {
  const r = await docsOf(v).getAtTier(id)
  return r !== null && 'body' in r ? r.body : undefined
}

/** owner with a tier-1 record; bob and carol are operators who hold no tier key. */
async function firm() {
  const store = memoryStore()
  const dbO = await open(store, 'owner', S)
  const vO = await dbO.openVault('v1')
  await docsOf(vO).putAtTier('secret', { id: 'secret', body: 'B' }, 1)
  await docsOf(vO).putAtTier('public', { id: 'public', body: 'P' }, 0)
  for (const u of ['bob', 'carol']) {
    await dbO.grant('v1', { userId: u, displayName: u, role: 'operator', secret: U, permissions: { docs: 'rw' } })
  }
  const asMember = async (user: string) => {
    const db = await open(store, user, U)
    return { db, vault: await db.openVault('v1') }
  }
  return { store, dbO, vO, asMember }
}

describe('core#65 — the grantor does not need the target\'s secret', () => {
  it('bob reads the delegated tier after refreshing; before it, and without asking, he does not', async () => {
    const { vO, asMember } = await firm()
    const bob = await asMember('bob')
    expect(await bodyAtTier(bob.vault, 'public')).toBe('P')      // control: his vault opens and reads
    expect(await bodyAtTier(bob.vault, 'secret')).not.toBe('B')  // control: the tier is closed

    const token = await vO.delegate({ toUser: 'bob', tier: 1, collection: 'docs', until: soon() })
    expect(token.sealedCek).toBeTruthy()
    expect(token.wrappedDek).toBeTruthy()

    const fresh = await asMember('bob')
    expect(await fresh.vault.refreshDelegations()).toHaveLength(1)
    expect(await bodyAtTier(fresh.vault, 'secret')).toBe('B')
  })

  it('carol can ENUMERATE the token and cannot open it — the audit property', async () => {
    const { vO, asMember } = await firm()
    const token = await vO.delegate({ toUser: 'bob', tier: 1, collection: 'docs', until: soon() })
    const carol = await asMember('carol')

    // She HOLDS the `_delegations` DEK — that is the audit capability, and it is
    // what makes "enumerable but unusable" a real distinction rather than a
    // restatement of "she has no key".
    const carolDeks = (carol.vault as unknown as { keyring: { deks: Map<string, unknown> } }).keyring.deks
    expect([...carolDeks.keys()]).toContain('_delegations')
    expect(await carol.vault.refreshDelegations()).toEqual([])
    expect(await bodyAtTier(carol.vault, 'secret')).not.toBe('B')

    // and bob still can — carol's failure is not the token being broken
    const bob = await asMember('bob')
    expect((await bob.vault.refreshDelegations()).map(t => t.id)).toEqual([token.id])
  })

  it('an expired token is not merged, and a revoked one stops being merged', async () => {
    const { vO, asMember } = await firm()
    await vO.delegate({ toUser: 'bob', tier: 1, collection: 'docs', until: new Date(Date.now() + 50).toISOString() })
    const later = await asMember('bob')
    expect(await later.vault.refreshDelegations(new Date(Date.now() + 3_600_000))).toEqual([])

    const live = await vO.delegate({ toUser: 'bob', tier: 1, collection: 'docs', until: soon() })
    const bob = await asMember('bob')
    expect(await bob.vault.refreshDelegations()).toHaveLength(1)
    await vO.revokeDelegation(live.id)
    const after = await asMember('bob')
    expect(await after.vault.refreshDelegations()).toEqual([])
  })

  it('a collection-wide token reaches the target the same way', async () => {
    const { vO, asMember } = await firm()
    await docsOf(vO).putAtTier('other', { id: 'other', body: 'O' }, 1)
    const token = await vO.delegate({ toUser: 'bob', tier: 1, until: soon() })
    expect(token.collection).toBeNull()
    expect(Object.keys(token.wrappedDeks ?? {})).toContain('docs#1')
    const bob = await asMember('bob')
    expect(await bob.vault.refreshDelegations()).toHaveLength(1)
    expect(await bodyAtTier(bob.vault, 'secret')).toBe('B')
  })

  it('refused at issue: a target that does not exist, and one whose keyring predates inboxes', async () => {
    const { store, dbO, vO } = await firm()
    await expect(vO.delegate({ toUser: 'nobody', tier: 1, collection: 'docs', until: soon() }))
      .rejects.toBeInstanceOf(DelegationTargetMissingError)

    // forge the pre-core#96 shape for carol, re-tagged with the owner's roster key
    const env = (await store.get('v1', '_keyring', 'carol'))!
    const f = parseKeyringEnvelope(env)
    const { inbox_key: _k, roster_tag: _t, ...rest } = f
    const deks = { ...rest.deks }; delete deks[INBOX_KEY_ID]
    const rosterKey = requireRosterKey((vO as unknown as { keyring: Parameters<typeof requireRosterKey>[0] }).keyring, 'test')
    const withEpoch = stampAuthority({ ...rest, deks }, f.roster_epoch)
    const legacy: KeyringFile = { ...withEpoch, roster_tag: await mintRosterTag(withEpoch, rosterKey) }
    await store.put('v1', '_keyring', 'carol', { ...env, _data: JSON.stringify(legacy) })

    await expect(vO.delegate({ toUser: 'carol', tier: 1, collection: 'docs', until: soon() }))
      .rejects.toBeInstanceOf(MemberInboxMissingError)
    void dbO
  })

  it('the vault CREATOR can be a target too — an owner keyring carries an inbox pair (core#65)', async () => {
    const { store, vO } = await firm()
    const owner = parseKeyringEnvelope((await store.get('v1', '_keyring', 'owner'))!)
    expect(owner.inbox_key?.pub).toBeTruthy()
    expect(Object.keys(owner.deks)).toContain(INBOX_KEY_ID)
    const token = await vO.delegate({ toUser: 'owner', tier: 1, collection: 'docs', until: soon() })
    expect((await vO.refreshDelegations()).map(t => t.id)).toContain(token.id)
  })
})
