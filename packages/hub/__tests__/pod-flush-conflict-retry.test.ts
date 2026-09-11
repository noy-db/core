/**
 * #10 — `wrapPodStore.flush()`'s conflict-retry loop must re-encode.
 *
 * The wrapper captured `bytes` and `expectedVersion` BEFORE the retry loop
 * and never recomputed them, so on `PodVersionConflictError` it merged the
 * remote snapshot into its maps and then re-sent the STALE version and the
 * PRE-MERGE bytes — a guaranteed repeat conflict against any OCC backend.
 * The loop burned its retries and threw, and the merge was discarded.
 *
 * ⚠️ THIS IS THE JOIN, AND IT IS WHY THE BUG SURVIVED. `pod-store-contract.test.ts`
 * names `PodVersionConflictError` and asserts the conflict is RAISED; the
 * backends were tested for raising it. Nobody ran the RECOVERY. A test that
 * only reaches the first `writeBundle` passes on the broken code — so this one
 * asserts what the SECOND call receives, which is the only place the defect
 * is visible.
 *
 * ⛔ THE INTERLEAVING IS LOAD-BEARING — `moveRemote()` is not scene-setting.
 * The wrapper lazy-`readBundle`s before its first mutation, so a client that
 * writes AFTER another has flushed silently refreshes to current and flushes
 * clean. The naive ordering therefore PASSES against the broken code; two
 * independent attempts (one here, one by the reporting consumer) both wrote it
 * that way first and saw green. A genuinely stale client needs:
 *   B mutates (lazy-loads at v1) → A advances the remote to v2 → B flushes.
 * Do not "simplify" the ordering, and do not drop `autoFlush: false` — with
 * autoFlush the mutation flushes at v1 before the race can be set up.
 */
import { describe, it, expect } from 'vitest'
import { wrapPodStore } from '../src/with-pod/pod-store.js'
import { PodVersionConflictError } from '../src/kernel/errors.js'
import type { NoydbPodStore, EncryptedEnvelope } from '../src/index.js'

const env = (v: number, data = 'd'): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: '2026-01-01T00:00:00.000Z', _iv: 'aXY=', _data: data }) as EncryptedEnvelope

interface Attempt {
  readonly expectedVersion: string | null | undefined
  readonly collections: readonly string[]
}

/**
 * A pod that refuses the FIRST write with a version conflict and then serves
 * a remote bundle at a higher version — the shape a second writer produces.
 * Records every `writeBundle` so the test can assert on the retry, not just
 * on the first attempt.
 */
function conflictingPod(remote: Record<string, Record<string, EncryptedEnvelope>>) {
  const attempts: Attempt[] = []
  // The version the wrapper learns on its initial load. A second writer then
  // moves the bundle to `remote-9` — so a retry that re-sends `v1` is stale by
  // construction, which is exactly the defect.
  let currentVersion = 'v1'
  const bundleAt = (vault: string, data: Record<string, unknown>, version: string) => ({
    bytes: new TextEncoder().encode(JSON.stringify({
      _noydb_bundle_store: 1, vault, ts: '2026-01-01T00:00:00.000Z', data,
    })),
    version,
  })
  const pod: NoydbPodStore = {
    kind: 'bundle',
    name: 'conflicting-pod',
    async listBundles() { return [] },
    async readBundle(vault: string) {
      // Before the conflict: empty at v1. After: the other writer's data at remote-9.
      return currentVersion === 'v1'
        ? bundleAt(vault, {}, 'v1')
        : bundleAt(vault, remote, 'remote-9')
    },
    async writeBundle(_vault: string, bytes: Uint8Array, expectedVersion?: string | null) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
        data: Record<string, unknown>
      }
      attempts.push({ expectedVersion, collections: Object.keys(parsed.data).sort() })
      // Real OCC: accept only the version the bundle is actually at.
      if (expectedVersion !== currentVersion) {
        throw new PodVersionConflictError(
          `version mismatch: expected ${String(expectedVersion)}, have ${currentVersion}`,
        )
      }
      return { version: 'v-final' }
    },
    async deleteBundle() { /* unused */ },
  }
  /** A second writer lands, moving the bundle past the version we loaded. */
  const moveRemote = () => { currentVersion = 'remote-9' }
  return { pod, attempts, moveRemote }
}

describe('#10 — flush() re-encodes on conflict retry', () => {
  it('retries with the REMOTE version and the MERGED bytes, and succeeds', async () => {
    const { pod, attempts, moveRemote } = conflictingPod({ theirs: { r2: env(1, 'remote-record') } })
    const store = wrapPodStore(pod, { autoFlush: false })

    // We load at v1 and buffer a local write…
    await store.put('acme', 'mine', 'r1', env(1, 'local-record'))
    // …and a second writer lands before our flush. This is the race.
    moveRemote()
    await expect(store.flush('acme')).resolves.toBeUndefined()

    expect(attempts).toHaveLength(2)

    // The retry is the whole point.
    //  - expectedVersion must be the version `readBundle` reported, not the stale one
    //  - the bytes must carry BOTH sides, or the merge was computed and thrown away
    expect(attempts[1]!.expectedVersion).toBe('remote-9')
    expect(attempts[1]!.collections).toEqual(['mine', 'theirs'])
  })

  it('still surfaces a conflict that does not resolve, rather than looping forever', async () => {
    // Every attempt conflicts: the loop must give up and throw, not hang.
    const pod: NoydbPodStore = {
      kind: 'bundle',
      name: 'always-conflicting-pod',
      async listBundles() { return [] },
      async readBundle() { return null },
      async writeBundle() {
        throw new PodVersionConflictError('always conflicts')
      },
      async deleteBundle() { /* unused */ },
    }
    const store = wrapPodStore(pod, { autoFlush: false })
    await store.put('acme', 'mine', 'r1', env(1))
    await expect(store.flush('acme')).rejects.toBeInstanceOf(PodVersionConflictError)
  })
})
