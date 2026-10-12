/**
 * family#156 — the half a pure predicate cannot prove: something CALLS it.
 *
 * ⛔ THIS FILE IS THE WHOLE POINT, and family#172 is why it exists. There,
 * `assertGroupRefuses` was correct, tested, and called from only one of the two
 * suites — so the guarantee was green everywhere and enforced nowhere. A
 * refusal predicate with no wiring test is that bug waiting to be rediscovered.
 *
 * ⚠️ `capabilities()` IS MOCKED, and it has to be: `enclave-aes` declares every
 * group, so with the real capsule neither refusal below can fire, and an
 * integration test would pass whether or not the assertion exists. Only
 * `capabilities` is replaced — every other door export stays real, so the
 * keyring's own unlock chain (`deriveKey`/`wrapKey`, the `authenticate`+`seal`
 * pair) still works and the vault really opens. The refusal under test is
 * hub's, not a broken capsule's.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/capsule/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/capsule/index.js')>()
  // What the shipped exclave declares. Frozen like the real one, so a caller
  // cannot widen it to make its own assertion pass.
  const set = Object.freeze(new Set(['cipher', 'digest', 'sign', 'codec']))
  return { ...actual, capabilities: () => set }
})

const { createNoydb } = await import('../src/kernel/noydb.js')
const { memoryStore } = await import('../src/kernel/memory-store.js')

const SECRET = 'correct-horse-battery-staple'
const plain = { store: memoryStore(), user: 'o', secret: SECRET }

describe('family#156 — createNoydb() refuses a service the capsule lacks', () => {
  it('a vault enabling nothing still opens against a four-group capsule', async () => {
    // POSITIVE FIRST. Without it every refusal below could be a capsule that
    // cannot construct at all, and the suite would read as working.
    const db = await createNoydb({ ...plain, store: memoryStore() })
    const vault = await db.openVault('V')
    const rows = vault.collection<{ a: string }>('rows')
    await rows.put('1', { a: 'x' })
    expect((await rows.get('1'))?.a).toBe('x')
  })

  it('⛔ blobs is refused, naming per-record-keys and the option key', async () => {
    const { withBlobs } = await import('../src/via/blob/active.js')
    await expect(createNoydb({ ...plain, store: memoryStore(), blobsStrategy: withBlobs() }))
      .rejects.toThrowError(expect.objectContaining({
        code: 'CAPSULE_NOT_SUPPORTED', group: 'per-record-keys',
      }))
    await expect(createNoydb({ ...plain, store: memoryStore(), blobsStrategy: withBlobs() }))
      .rejects.toThrowError(/blobsStrategy/)
  })

  it('⛔ it refuses BEFORE resolving defaults, so nothing is half-built', async () => {
    // `createNoydb` resolves a default mesh, user API and policy service before
    // constructing. A capability discovered after that work is a half-built
    // vault — the whole reason this is a construction-time check.
    const { withClassified } = await import('../src/via/classified/active.js')
    await expect(createNoydb({ ...plain, store: memoryStore(), classifiedStrategy: withClassified() }))
      .rejects.toThrowError(expect.objectContaining({ group: 'classify' }))
  })
})

describe('family#156 — vault.collection() refuses a declared field the capsule lacks', () => {
  it('⛔ deterministicFields is refused at declaration, not at first write', async () => {
    const db = await createNoydb({ ...plain, store: memoryStore() })
    const vault = await db.openVault('V')
    // ⚠️ `acknowledgeDeterministicRisk` is passed deliberately: without it the
    // EXISTING leaks-equality gate throws first and this case would pass for
    // the wrong reason — a control that cannot distinguish two refusals is not
    // testing either of them.
    expect(() => vault.collection<{ email: string }>('users', {
      deterministicFields: ['email'], acknowledgeDeterministicRisk: true,
    } as never))
      .toThrowError(expect.objectContaining({ code: 'CAPSULE_NOT_SUPPORTED', group: 'deterministic' }))
  })

  it('⛔ sensitiveFields is refused, naming sealing', async () => {
    const db = await createNoydb({ ...plain, store: memoryStore() })
    const vault = await db.openVault('V')
    // ⚠️ The OPTION IS `sensitive`, not `sensitiveFields` — the latter is the
    // normalised Set the Collection receives, built in `collection-config.ts`.
    // Asserting against the internal name is how a wiring test passes while the
    // public option goes unchecked.
    expect(() => vault.collection<{ ssn: string }>('people', { sensitive: ['ssn'] } as never))
      .toThrowError(expect.objectContaining({ group: 'sealing' }))
  })

  it('⭐ perRecordKeys is refused — reachable with every named service absent', async () => {
    // The delta the ruling's three services missed. This collection enables no
    // service at all and still needs the group.
    const db = await createNoydb({ ...plain, store: memoryStore() })
    const vault = await db.openVault('V')
    expect(() => vault.collection<{ a: string }>('cekRows', { perRecordKeys: true } as never))
      .toThrowError(expect.objectContaining({ group: 'per-record-keys' }))
  })

  it('a collection declaring no protected field is accepted and round-trips', async () => {
    // The control for all three above: the refusal is about the DECLARATION,
    // not about collections in general.
    const db = await createNoydb({ ...plain, store: memoryStore() })
    const vault = await db.openVault('V')
    const rows = vault.collection<{ a: string }>('plain')
    await rows.put('1', { a: 'y' })
    expect((await rows.get('1'))?.a).toBe('y')
  })
})
