/**
 * The suite, run against hub's own mesh and against the synthetic the controls
 * are built from (core#46).
 *
 * ⛔ WHY THIS PACKAGE HAD NO TEST AT ALL. Its `include` pointed at `src/`,
 * where it has never had a test file, and its script passed
 * `--passWithNoTests` — so the job went green having collected nothing, and it
 * shipped that way in `0.0.0-dev-20260917060654`.
 *
 * ## ⭐ Hub's own default IS reachable, and `@noy-db/hub/by` says otherwise
 *
 * That subpath's module comment records, as a cost, that `StoreMesh` is not on
 * the published surface and therefore "`@noy-db/test-mesh-conformance` cannot
 * import it" — generalised to: *a port's in-hub default is coverable by its
 * published kit only if it is on the published surface.*
 *
 * The first half stays true — nothing here imports
 * `with-shape/schema-update`. The generalisation does not: `createNoydb()`
 * installs the store-backed default and `db.mesh` hands it back, so the kit
 * reaches hub's real implementation through the public class surface without
 * the module being exported. **Reachability, not exportedness, is what
 * decides.** (`mesh` is `@internal`-tagged, which is why this is the kit's own
 * test and not advice to a `by-*` author.)
 *
 * Two clients over ONE store is the pair the contract asks for: coordination
 * state shared, participants distinct.
 *
 * ## Why the synthetic is here too
 *
 * `fixtures/mesh.ts` at `defect: 'none'` is the baseline its own controls are
 * measured against. Without it green, a red control would not attribute — it
 * could be failing for a reason that has nothing to do with the defect named
 * in the file.
 *
 * ⚠️ Green here proves the kit can PASS. `kit-contract.test.ts` is the half
 * that proves it can FAIL, and neither is worth much alone.
 */
import { createNoydb, memoryStore, type Noydb } from '@noy-db/hub'
import type { NoydbMesh } from '@noy-db/hub/by'
import { runMeshConformanceTests } from '../src/index.js'
import { meshPair } from './fixtures/mesh.js'

/**
 * The clients behind a pair, so `cleanup` can close them.
 *
 * ⚠️ `createNoydb` installs a POLLING mesh. Leaving the instances open leaks a
 * timer per pair for the rest of the run, which is the kind of thing that
 * surfaces later as an unrelated flake.
 */
const clients = new WeakMap<NoydbMesh, Noydb>()

runMeshConformanceTests('StoreMesh — hub default, two clients over one store', {
  pair: async () => {
    const store = memoryStore()
    const open = async (): Promise<Noydb> =>
      await createNoydb({ store, user: 'mesh-conformance', secret: 'pw-mesh-conformance-01' })
    const [a, b] = [await open(), await open()]
    clients.set(a.mesh, a)
    clients.set(b.mesh, b)
    return [a.mesh, b.mesh] as const
  },
  cleanup: async (pair) => {
    for (const m of pair) await clients.get(m)?.close()
  },
})

runMeshConformanceTests('synthetic in-memory mesh — the baseline the controls break', {
  pair: () => meshPair('none'),
})
