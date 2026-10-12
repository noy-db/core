/**
 * family#163 — the per-record rekey is a read-modify-write, and it had no CAS.
 *
 * ⛔ MEASURED BEFORE THE FIX: a concurrent writer between the read and the
 * write was silently lost, and the stored version REGRESSED with it. The
 * rotation did not throw, `_v` went back to 1, and the concurrent body was
 * gone.
 *
 * ⚠️ THE REGRESSION IS THE WORSE HALF. `rekeyEnvelopeToDek` carries `_v`
 * through unchanged — an in-place rekey is "same `_v`, new bytes" by design
 * (core#100) — so writing the re-keyed copy of version 5 over a concurrently
 * written version 6 puts the record back at 5. Sync orders by `_v`, so a peer
 * that already pulled 6 will never re-pull 5: the loss propagates as
 * convergence.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/index.js'
import { rotateKeys, loadKeyring } from '../src/with-party/team/keyring.js'

const SECRET = 'pw-rotate-163'

/**
 * ⛔ A CONCURRENT WRITE CANNOT BE FAKED BY BUMPING `_v`, and finding that out
 * was the useful part of writing this file. My first version injected the same
 * ciphertext at `_v + 1`, which hub refuses with "record may have been tampered
 * with" — correctly, because `recordAadFor` binds the VERSION into the AAD, so
 * a re-versioned body is exactly the store attack
 * `adversarial-store-identity.test.ts` exists to catch. A legitimate concurrent
 * write is a genuine re-encrypt at the new version, so it has to come from a
 * real second session holding the old DEK.
 *
 * That is also the realistic shape: two processes on one store, one rotating
 * and one still writing.
 */
/** One real concurrent write, slipped in behind the rotation's first read. */
async function oneShotRacer(): Promise<{ store: NoydbStore; inner: NoydbStore; n: number }> {
  const inner = memoryStore()
  const db = await createNoydb({ store: inner, user: 'alice', secret: SECRET })
  const vault = await db.openVault('acme')
  await vault.collection<{ id: string; n: number }>('docs').put('d1', { id: 'd1', n: 1 })

  const other = await createNoydb({ store: inner, user: 'alice', secret: SECRET })
  const otherVault = await other.openVault('acme')
  await db.close()

  let armed = true
  const store = {
    ...inner,
    async get(v: string, c: string, rid: string) {
      const env = await inner.get(v, c, rid)
      if (armed && c === 'docs' && rid === 'd1' && env) {
        armed = false
        // A genuine re-encrypt at the next version, from a session that still
        // holds the old DEK. This is the write the rotation must not lose.
        await otherVault.collection<{ id: string; n: number }>('docs').put('d1', { id: 'd1', n: 42 })
      }
      // ⛔ RETURNS THE STALE ENVELOPE, and the order is the whole fixture. My
      // first rewrite injected BEFORE the read, so the rotation saw the already
      // updated record, there was no race, and both cases passed with the fix
      // stashed. The mutation check is what caught it — a test that stopped
      // testing the thing while still looking like it did.
      return env
    },
  } as NoydbStore
  return { store, inner, n: 42 }
}

describe('family#163 — rotateKeys CASes each record it rewrites', () => {
  it('⭐ a concurrent write is not lost, and the version does not regress', async () => {
    const { store, inner, n } = await oneShotRacer()
    const before = (await inner.get('acme', 'docs', 'd1'))!._v

    const k = await loadKeyring(store, 'acme', { userId: 'alice', secret: SECRET })
    await rotateKeys(store, 'acme', k, { collections: ['docs'] })

    const after = (await inner.get('acme', 'docs', 'd1'))!
    expect(after._v, 'the rotation wrote over a newer version and regressed it').toBeGreaterThan(before)

    // ⚠️ And the CONTENT is the concurrent write, not the pre-rotation body.
    // A version check alone passes for a rotation that kept the old bytes at a
    // bumped number, which is the same loss with a better-looking `_v`.
    const db = await createNoydb({ store: inner, user: 'alice', secret: SECRET })
    const vault = await db.openVault('acme')
    expect((await vault.collection<{ id: string; n: number }>('docs').get('d1'))?.n).toBe(n)
    await db.close()
  })

  it('a writer that keeps winning fails LOUDLY rather than looping', async () => {
    // ⛔ The retry is bounded on purpose. A rotation holding the caller's
    // keyring and spinning forever is worse than a loud failure a resume can
    // finish — and this function is built to be resumable, so a caller that
    // re-runs it with the same new DEK completes the collection.
    const inner = memoryStore()
    const db = await createNoydb({ store: inner, user: 'alice', secret: SECRET })
    const vault = await db.openVault('acme')
    await vault.collection<{ id: string; n: number }>('docs').put('d1', { id: 'd1', n: 1 })
    const other = await createNoydb({ store: inner, user: 'alice', secret: SECRET })
    const otherVault = await other.openVault('acme')
    await db.close()

    let writes = 0
    const always = {
      ...inner,
      async get(v: string, c: string, rid: string) {
        const env = await inner.get(v, c, rid)
        if (c === 'docs' && rid === 'd1' && env) {
          writes += 1
          await otherVault.collection<{ id: string; n: number }>('docs').put('d1', { id: 'd1', n: writes })
        }
        return env
      },
    } as NoydbStore

    const k = await loadKeyring(always, 'acme', { userId: 'alice', secret: SECRET })
    await expect(rotateKeys(always, 'acme', k, { collections: ['docs'] })).rejects.toThrow(/[Cc]onflict/)
    // Bounded: it gave up rather than retrying indefinitely.
    expect(writes).toBeLessThan(10)
  })

  it('an uncontended rotation still completes — the control', async () => {
    // Without this, a fix that refused every write would satisfy the case above
    // by never rotating anything.
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault('acme')
    await vault.collection<{ id: string; n: number }>('docs').put('d1', { id: 'd1', n: 1 })
    await db.close()

    const k = await loadKeyring(store, 'acme', { userId: 'alice', secret: SECRET })
    const result = await rotateKeys(store, 'acme', k, { collections: ['docs'] })
    expect(result.rewritten.map((r) => r.id)).toContain('d1')

    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const v2 = await db2.openVault('acme')
    expect((await v2.collection<{ id: string; n: number }>('docs').get('d1'))?.n).toBe(1)
    await db2.close()
  })
})
