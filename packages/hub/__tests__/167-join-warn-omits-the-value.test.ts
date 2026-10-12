/**
 * family#167 — `.join()`'s dangling-ref warning logged a decrypted value.
 *
 * ⛔ WHY IT IS A LEAK EVEN WHEN THE VALUE IS AN ORDINARY ID. The message
 * carried `"<target>:<refId>"`, and `refId` is read out of a DECRYPTED record
 * body. Two things escape with it:
 *
 *  - the VALUE, which need not be opaque — a ref resolved by natural key is
 *    routinely an email or an account number;
 *  - the ASSOCIATION, which leaks even when the value is a store key the
 *    backend already sees. The store knows `users/u-1` exists; it does not know
 *    which post references it, because that field sits inside the encrypted
 *    body. The log publishes the edge.
 *
 * And `console.warn` goes wherever the host collects logs — a file, a shipper,
 * a cloud sink — which is outside the boundary this library exists to hold. It
 * leaked on an ordinary read path, in the mode a caller picks to be lenient.
 *
 * ⚠️ A record ID in a log is a different question and is NOT what this fixes.
 * The store already sees every key it is asked for, so `id="x"` in a
 * derivation-failure warning discloses nothing new. The distinction is
 * decrypted-body content versus a store key, not "anything that looks like an
 * identifier".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNoydb, memoryStore, ref, DanglingReferenceError } from '../src/index.js'
import '../src/kernel/query/relate/index.js'

const SECRET = 'pw-join-warn-167'
/** A ref resolved by natural key — the shape that makes the leak obvious. */
const SECRET_VALUE = 'alice@private.example'

afterEach(() => { vi.restoreAllMocks() })

interface Post { authorId: string | null; title: string }

/**
 * ⚠️ A DISTINCT field→target PAIR PER CASE, and it is not hygiene. The warn
 * dedup is a MODULE-LEVEL `Set` that is never reset, so the first case to warn
 * for a pair consumes the only warning the process will ever emit for it —
 * reusing one pair made the second case assert against an empty string.
 *
 * ⭐ That Set is also why the fix is bigger than the message. Keyed by
 * `field → target:refId` it RETAINED every dangling value in memory for the
 * process lifetime, where a heap dump or a memory inspector would find them.
 * Keyed by `field → target` it holds schema only, and it stops growing with
 * the data.
 */
async function postsWithDanglingRef(suffix: string) {
  const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: SECRET })
  const v = await db.openVault('acme')
  // The target exists but holds nothing, so the ref dangles on read.
  v.collection<{ name: string }>(`authors${suffix}`)
  const posts = v.collection<Post>(`posts${suffix}`, {
    refs: { [`authorId${suffix}`]: ref(`authors${suffix}`, 'warn') },
  } as never)
  await posts.put('p1', { [`authorId${suffix}`]: SECRET_VALUE, title: 'hello' } as never)
  return { db, posts, field: `authorId${suffix}`, target: `authors${suffix}` }
}

describe('family#167 — the dangling-ref warning omits the ref value', () => {
  it('⛔ the warning does NOT contain the ref value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, posts, field } = await postsWithDanglingRef('A')

    posts.query().join(field as never, { as: 'author' }).toArray()

    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged, 'the warning fired at all — the fixture is not exercising it').not.toBe('')
    expect(logged, 'a decrypted field value reached the log').not.toContain(SECRET_VALUE)
    await db.close()
  })

  it('and it still says enough to act on — field, target, and where to get the id', async () => {
    // ⚠️ The control for the fix. Deleting the warning entirely would pass the
    // case above, and a warning a reader cannot act on is barely better.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, posts, field, target } = await postsWithDanglingRef('B')

    posts.query().join(field as never, { as: 'author' }).toArray()

    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged).toContain(field)  // the FIELD is schema, not data
    expect(logged).toContain(target) // so is the target
    expect(logged).toMatch(/strict/)     // and where the id IS available
    await db.close()
  })

  it('the join still attaches null — behaviour is unchanged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, posts, field } = await postsWithDanglingRef('C')

    const rows = posts.query().join(field as never, { as: 'author' }).toArray()
    expect(rows).toHaveLength(1)
    expect((rows[0] as { author: unknown }).author).toBeNull()
    await db.close()
  })

  it('⭐ the value is still available on the ERROR, which is a different channel', async () => {
    // The distinction the fix rests on: an Error handed to the caller is not
    // egress — they decrypted the record. A log is, because it leaves the
    // process for wherever the host collects logs.
    //
    // ⚠️ Asserted on the type rather than through a dangling STRICT ref,
    // because a strict ref is validated at WRITE time: `put` already refuses
    // one that cannot be satisfied, so the read-time path is not reachable from
    // a fixture without deleting a target that `strict` will not let go.
    const err = new DanglingReferenceError({
      field: 'authorId', target: 'authors', refId: SECRET_VALUE, message: 'x',
    })
    expect(err.refId).toBe(SECRET_VALUE)
  })

  it('warns ONCE per leg, not once per dangling value', async () => {
    // The dedup moved from (field, target, value) to (field, target). Fewer
    // lines, and no key derived from record content is retained anywhere.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: SECRET })
    const v = await db.openVault('acme')
    v.collection<{ name: string }>('authors2')
    const posts = v.collection<Post>('posts2', { refs: { authorId: ref('authors2', 'warn') } })
    await posts.put('p1', { authorId: 'a@x.example', title: 'one' })
    await posts.put('p2', { authorId: 'b@x.example', title: 'two' })

    posts.query().join('authorId', { as: 'author' }).toArray()

    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('dangling'))
    expect(lines).toHaveLength(1)
    await db.close()
  })
})
