/**
 * family#156, third refusal point — the POSTURE groups, at the keyring.
 *
 * ⭐ WHAT THE EARLIER MEASUREMENT FOUND. `authenticate` and `seal` are not
 * implied by any field form or any service: `deriveKey` (secret → KEK) and
 * `wrapKey`/`unwrapKey` (KEK wraps DEK) are called only from the keyring's
 * unlock chain. So what requires them is opening a vault that HAS a keyring —
 * which is why the guard sits at `loadKeyring`/`createOwnerKeyring` rather than
 * in `openVault`: the ruling says "before any keyring is read or written", and
 * those entries are literally that. They also cover `grant`, `rotateSecret` and
 * recovery, which never go through `openVault`.
 *
 * ⛔ THE PLAINTEXT CASE IS THE LOAD-BEARING CONTROL, not a nicety. An
 * unconditional refusal would read as stricter and would make `exclave-plain`
 * unable to open any vault at all — its entire purpose. The gate is structural:
 * `createNoydb({ encrypt: false })` short-circuits in `_getKeyringInternal` to
 * `createPlaintextKeyring()` and never reaches either guarded entry. So this
 * file asserts BOTH directions, and the plaintext one would fail loudly if the
 * guard were ever hoisted into `openVault` or made unconditional.
 *
 * ⚠️ `capabilities()` is mocked down to the exclave's four groups, as in
 * `capsule-requirements-wiring.test.ts`: `enclave-aes` declares every group, so
 * with the real capsule neither outcome below can be distinguished.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/capsule/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/capsule/index.js')>()
  const set = Object.freeze(new Set(['cipher', 'digest', 'sign', 'codec']))
  return { ...actual, capabilities: () => set }
})

const { createNoydb } = await import('../src/kernel/noydb.js')
const { memoryStore } = await import('../src/kernel/memory-store.js')

const SECRET = 'correct-horse-battery-staple'

describe('family#156 — a capsule without the posture groups cannot hold a keyring', () => {
  it('⭐ a PLAINTEXT vault still opens and round-trips — the control that matters', async () => {
    // If this ever fails, the refusal was hoisted out of the keyring entries or
    // made unconditional, and the plaintext capsule the whole exclave exists to
    // be has just been bricked. Asserted FIRST, deliberately: every refusal
    // below is only meaningful if this one passes.
    const db = await createNoydb({ store: memoryStore(), user: 'o', encrypt: false })
    const vault = await db.openVault('V')
    const rows = vault.collection<{ a: string }>('rows')
    await rows.put('1', { a: 'x' })
    expect((await rows.get('1'))?.a).toBe('x')
    await db.close()
  })

  it('⛔ an ENCRYPTED vault is refused, naming a posture group', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'o', secret: SECRET })
    await expect(db.openVault('V')).rejects.toThrowError(expect.objectContaining({
      code: 'CAPSULE_NOT_SUPPORTED',
    }))
  })

  it('⛔ the refusal names the keyring entry, so the message says where', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'o', secret: SECRET })
    await expect(db.openVault('V')).rejects.toThrowError(/Keyring\("V"\)|keyring/i)
  })

  it('⛔ it refuses BEFORE the keyring is read or written — the store stays untouched', async () => {
    // The ruling's wording, made a property. A capability discovered after a
    // keyring write is a vault with a keyring no capsule can unwrap — strictly
    // worse than refusing, because the bytes are now on disk.
    const inner = memoryStore()
    const touched: string[] = []
    const store = {
      ...inner,
      get: (v: string, c: string, id: string) => { touched.push(`get ${c}`); return inner.get(v, c, id) },
      put: (...args: Parameters<typeof inner.put>) => { touched.push(`put ${args[1]}`); return inner.put(...args) },
    }
    const db = await createNoydb({ store, user: 'o', secret: SECRET })
    await expect(db.openVault('V')).rejects.toThrowError(expect.objectContaining({ code: 'CAPSULE_NOT_SUPPORTED' }))
    expect(
      touched.filter((t) => t.includes('_users') || t.includes('_keyring')),
      `a keyring read or write happened before the refusal: ${touched.join(', ')}`,
    ).toEqual([])
    await db.close()
  })
})
