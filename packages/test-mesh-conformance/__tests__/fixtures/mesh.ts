/**
 * A synthetic `NoydbMesh`, and the two ways of breaking it that the kit must
 * catch (core#46).
 *
 * ⚠️ NOT a `.test.ts`, and neither are the suites beside it: they are run by a
 * CHILD vitest from `kit-contract.test.ts`, which reads their exit code as
 * evidence. The main run collects only `*.test.ts`, so a suite that is supposed
 * to FAIL cannot fail the suite that reads it.
 *
 * ## Why a synthetic at all, when `reference.test.ts` has hub's own
 *
 * The green side is better served by hub's `StoreMesh` — real code, reached
 * through `db.mesh`. But a control has to be a SINGLE, NAMED defect over an
 * otherwise-conformant implementation, and `StoreMesh` offers no seam for
 * "same code, but the staleness filter is gone". So the controls are built over
 * a mesh small enough to break precisely, and `defect: 'none'` runs in the main
 * suite — without that baseline a red control would not attribute: it could be
 * failing because the synthetic is wrong somewhere else entirely.
 *
 * Delivery here is synchronous. That is conformant (the contract permits any
 * delivery up to the kit's `waitFor` budget) and it is deliberately the
 * EASIEST case to pass — a control that fails a synchronous mesh is failing on
 * its defect, not on timing.
 */
import type { NoydbMesh, WriterPresence, FenceDoc } from '@noy-db/hub/by'

/** `none` is the reference; the other two are the controls. */
export type Defect = 'none' | 'per-instance-fence' | 'ignores-staleness'

const DEFAULT_FENCE: FenceDoc = { currentSchemaVersion: 0, fenceState: 'normal' }

interface Coordination {
  readonly fences: Map<string, FenceDoc>
  readonly fenceListeners: Map<string, Set<(f: FenceDoc) => void>>
  readonly presence: Map<string, Map<string, WriterPresence>>
  readonly presenceListeners: Map<string, Set<(w: readonly WriterPresence[]) => void>>
}

const newCoordination = (): Coordination => ({
  fences: new Map(),
  fenceListeners: new Map(),
  presence: new Map(),
  presenceListeners: new Map(),
})

function listeners<T>(m: Map<string, Set<T>>, vault: string): Set<T> {
  let s = m.get(vault)
  if (!s) m.set(vault, (s = new Set()))
  return s
}

/**
 * One participant.
 *
 * @param fenceSide - coordination state the fence half reads and writes. The
 *   SAME object as `presenceSide` for a conformant mesh; a private one is the
 *   `per-instance-fence` defect.
 * @param presenceSide - coordination state the presence half uses.
 * @param staleness - when false, `reachableWriters` ignores `staleMs`.
 */
function participant(fenceSide: Coordination, presenceSide: Coordination, staleness: boolean): NoydbMesh {
  return {
    async setFence(vault, fence) {
      fenceSide.fences.set(vault, fence)
      for (const fn of listeners(fenceSide.fenceListeners, vault)) fn(fence)
    },
    async readFence(vault) {
      return fenceSide.fences.get(vault) ?? DEFAULT_FENCE
    },
    observeFence(vault, onChange) {
      const set = listeners(fenceSide.fenceListeners, vault)
      set.add(onChange)
      return () => set.delete(onChange)
    },
    async reportPresence(vault, p) {
      let writers = presenceSide.presence.get(vault)
      if (!writers) presenceSide.presence.set(vault, (writers = new Map()))
      writers.set(p.writerId, p)
      const snapshot = [...writers.values()]
      for (const fn of listeners(presenceSide.presenceListeners, vault)) fn(snapshot)
    },
    observePresence(vault, onChange) {
      const set = listeners(presenceSide.presenceListeners, vault)
      set.add(onChange)
      return () => set.delete(onChange)
    },
    async reachableWriters(vault, { staleMs, now }) {
      const writers = [...(presenceSide.presence.get(vault)?.values() ?? [])]
      // ⛔ THE DEFECT, when `staleness` is false: a dead writer stays in the
      // quorum input, so the drain barrier waits on someone who is never
      // coming back and the cutover hangs until its timeout.
      return staleness ? writers.filter((w) => now - w.lastSeen <= staleMs) : writers
    },
  }
}

/** Two participants, sharing coordination state unless the defect removes it. */
export function meshPair(defect: Defect = 'none'): readonly [NoydbMesh, NoydbMesh] {
  const shared = newCoordination()
  // ⛔ THE DEFECT, for `per-instance-fence`: each participant keeps its OWN
  // fence. Every single-participant case still passes — which is exactly the
  // implementation the kit's "the fixture is a PAIR, not an instance" rule
  // exists to refuse, and a migration proceeding while another writer believes
  // the vault is normal is what it costs.
  const fenceA = defect === 'per-instance-fence' ? newCoordination() : shared
  const fenceB = defect === 'per-instance-fence' ? newCoordination() : shared
  const staleness = defect !== 'ignores-staleness'
  return [participant(fenceA, shared, staleness), participant(fenceB, shared, staleness)] as const
}
