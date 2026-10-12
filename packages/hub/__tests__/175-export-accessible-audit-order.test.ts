/**
 * family#175 — `exportAccessibleData` recorded its audit entry after the build.
 *
 * ⛔ WHAT THAT UNDER-RECORDED. A build that throws part-way has already READ
 * the caller's accessible collections, and with `reKey` it has decrypted them
 * in-process to re-encrypt under the export secret. A failure does not un-read
 * them — so an entry written only on success reports "no export" for an access
 * that happened, which is the case an audit reader cares about most.
 *
 * ⚠️ The reason string is unchanged. A consumer greps `user-export:` out of the
 * ledger, so the entry's MEANING moves from "completed" to "attempted" while
 * its shape does not. For a trail of data ACCESS that is the stronger reading
 * of the same event, and it is the same argument family#151 made for
 * `exportWith`.
 *
 * ⚠️ THIS IS A NARROWER CASE THAN family#151's, and worth saying so: a bundle
 * export produces an ENCRYPTED pod, not plaintext, so without `reKey` the
 * failure may not have decrypted anything. The access still happened.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore, exportAccessibleData } from '../src/index.js'
import type { NoydbStore } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withPortability } from '../src/with-audit/portability/index.js'

const SECRET = 'pw-export-accessible-175'

async function seeded(store: NoydbStore) {
  const db = await createNoydb({
    store, user: 'alice', secret: SECRET,
    historyStrategy: withHistory(), portabilityStrategy: withPortability(),
  })
  const vault = await db.openVault('acme')
  await vault.collection<{ id: string; n: number }>('rows').put('r1', { id: 'r1', n: 1 })
  return { db, vault }
}

const reasons = async (
  vault: Awaited<ReturnType<typeof seeded>>['vault'],
): Promise<Array<string | undefined>> =>
  (await vault.ledger().entries()).map((e) => e.reason)

describe('family#175 — the export audit entry precedes the build', () => {
  it('a successful export still records exactly one entry', async () => {
    // The control. Moving the append must not duplicate it or drop it.
    const { db, vault } = await seeded(memoryStore())
    await exportAccessibleData(vault)
    expect((await reasons(vault)).filter((r) => r === 'user-export:alice')).toHaveLength(1)
    await db.close()
  })

  it('⭐ the append PRECEDES the build in source', async () => {
    // ⛔ ASSERTED STRUCTURALLY, and the reason is that I could not reach the
    // failure path from a fixture. Two attempts, both of which would have
    // passed this case for the wrong reason:
    //
    //   1. A hostile store that fails `list`/`loadAll`. By the time
    //      `exportAccessible` runs the vault is hydrated, so `writePod` reads
    //      the decrypted cache and the export SUCCEEDED.
    //   2. A weak `reKey` secret. Accepted — `writePod` applies no strength
    //      gate to `exportSecret`, which is a separate finding and reported as
    //      one rather than fixed here.
    //
    // So the property is pinned where it is visible: the ledger append must
    // come before the call that reads and re-encrypts. This case fails with the
    // fix stashed, which is what makes it worth keeping.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      fileURLToPath(new URL('../src/with-audit/portability/export-accessible.ts', import.meta.url)),
      'utf8',
    )
    const body = src.slice(src.indexOf('export async function exportAccessibleData'))
    const appendAt = body.indexOf('_getLedgerOrNull()?.append')
    const buildAt = body.indexOf('buildAccessibleBundle(vault')
    expect(appendAt, 'no ledger append found — the regex drifted').toBeGreaterThan(-1)
    expect(buildAt, 'no build call found — the regex drifted').toBeGreaterThan(-1)
    expect(
      appendAt,
      'the audit entry is written AFTER the build — a build that throws records nothing',
    ).toBeLessThan(buildAt)
  })

  it('is still a no-op without a history strategy — no phantom _ledger DEK', async () => {
    // Unchanged by the reorder, and worth pinning: creating the audit trail as
    // a side effect of an export would opt the caller into a subsystem they
    // never asked for.
    const db = await createNoydb({
      store: memoryStore(), user: 'alice', secret: SECRET,
      portabilityStrategy: withPortability(),
    })
    const vault = await db.openVault('acme')
    await vault.collection<{ id: string }>('rows').put('r1', { id: 'r1' })
    expect((await exportAccessibleData(vault)).byteLength).toBeGreaterThan(0)
    await db.close()
  })
})
