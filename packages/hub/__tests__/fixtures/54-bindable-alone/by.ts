/**
 * `@noy-db/hub/by`, bound ALONE — a session-share transport's whole import
 * list (#54).
 *
 * ⛔ One import line, and it must stay one. See `to.ts` for why.
 *
 * ⭐ The two `Unsubscribe` return annotations are the regression test for the
 * gap this fixture found: before #54 a transport author returned `() => {}`
 * with nothing to annotate it against. They stop compiling if the type leaves
 * this port again.
 *
 * ⛔ `fenceState: 'normal'` below stays a LITERAL, and that is the right
 * answer rather than the remaining half of the gap. Exporting `FenceState`
 * here would collide with the `FenceState → FenceDoc` codemod row, which is
 * scoped to `./by` and disambiguates by import source — see the port's own
 * header. A literal type-checks against `FenceDoc` and costs a `by-*` author
 * nothing but the annotation.
 */
import {
  isQuorum,
  runDrainBarrier,
  type NoydbMesh,
  type WriterPresence,
  type FenceDoc,
  type DrainBarrierOptions,
  type Unsubscribe,
} from '@noy-db/hub/by'

/** The contract a `by-*` package implements, written against the port alone. */
class LoopbackMesh implements NoydbMesh {
  #fence: FenceDoc = { currentSchemaVersion: 1, fenceState: 'normal' }
  readonly #writers = new Map<string, WriterPresence>()

  async setFence(_vault: string, fence: FenceDoc): Promise<void> {
    this.#fence = fence
  }

  async readFence(): Promise<FenceDoc> {
    return this.#fence
  }

  observeFence(_vault: string, onChange: (f: FenceDoc) => void): Unsubscribe {
    onChange(this.#fence)
    return () => {}
  }

  async reportPresence(_vault: string, p: WriterPresence): Promise<void> {
    this.#writers.set(p.writerId, p)
  }

  observePresence(_vault: string, onChange: (writers: readonly WriterPresence[]) => void): Unsubscribe {
    onChange([...this.#writers.values()])
    return () => {}
  }

  async reachableWriters(): Promise<readonly WriterPresence[]> {
    return [...this.#writers.values()]
  }
}

/**
 * The caller half: run the drain barrier over the transport and evaluate the
 * quorum predicate the barrier itself uses — the two things a `by-*` author
 * must be able to reach to know their transport satisfies the protocol.
 */
export async function exercise(): Promise<readonly [boolean, boolean]> {
  const mesh = new LoopbackMesh()
  await mesh.reportPresence('v', {
    writerId: 'w1',
    sessionId: 's1',
    lastSeen: 0,
    quiescedAtVersion: 2,
  })

  const options: DrainBarrierOptions = {
    vault: 'v',
    generation: 2,
    writerId: 'orchestrator',
    onFlush: async () => {},
    staleMs: 1_000,
    quiesceTimeoutMs: 5_000,
    now: () => 0,
  }

  let ran = false
  await runDrainBarrier(mesh, options, async () => {
    ran = true
  })

  return [ran, isQuorum(await mesh.reachableWriters(), 2, 'orchestrator')] as const
}
