/**
 * core#76 — point-in-time RESTORE, as forward writes.
 *
 * `vault.at(T)` reconstructs any record at T and is read-only by contract.
 * `restoreTo(T)` takes that reconstruction and WRITES it: for every record
 * whose state at T differs from its state now, put the T-state as a new
 * version; for every record that exists now and did not exist at T, delete it.
 *
 * ## Why forward writes, and not a rewrite of history
 *
 * Every write goes through `Collection.put` / `.delete`, so guards, periods,
 * history and the ledger all see it. The restore is therefore itself an
 * audited, reversible event — `restoreTo(T)` can be undone by another
 * `restoreTo`, the ledger's tamper-evidence is untouched, and the result
 * replicates through ordinary sync because it IS ordinary versioned writes.
 * ⭐ That is the whole argument for this over a pod: a pod restore is state
 * REPLACEMENT and needs core#71/#72 to be safe under sync; this needs nothing,
 * because the stack already knows how to gate, audit and replicate a write.
 *
 * ## What bounds it
 *
 * ⚠️ Accuracy is bounded by history retention. If `historyConfig.maxVersions`
 * pruned the versions around T, the reconstruction at T is incomplete and so
 * is the restore — `at(T)` returns null for a record whose earliest retained
 * snapshot is after T, and this treats that as "did not exist at T". A vault
 * that prunes history cannot honestly point-in-time restore past the prune
 * horizon, and a pod is the answer there (core#77).
 *
 * ⛔ BLOBS ARE NOT RESTORED AND ARE NOT REPORTED. `_history` holds record
 * envelopes, not chunks; a record's blob fields at T reference chunks that may
 * since have been compacted away. The record comes back with its handles
 * intact and the chunks may or may not still be there. Detecting that
 * reliably means resolving every handle against `_blob_chunks`, which is a
 * blob-subsystem concern this module deliberately does not reach into — a
 * `blobsUnrecoverable: []` that is empty because nothing looked would be worse
 * than the silence, because it would read as a guarantee.
 */
import type { RestoreToOptions, RestoreToResult } from '../../kernel/types.js'
import type { RestoreToHost } from '../../port/with/restore-host.js'
import { parseHistoryId } from './history.js'

/** Local to avoid a new export from `history.ts` for one string. */
const HISTORY_COLLECTION = '_history'

/**
 * Collections to consider: what is live now, PLUS what history knows about.
 *
 * ⭐ The union is the point. A collection dropped since T is absent from the
 * live store, and a restore that only walked live collections would silently
 * decline to bring it back — the exact case ("the store drifted") this
 * feature exists for.
 */
async function candidateCollections(host: RestoreToHost): Promise<string[]> {
  const names = new Set(await host.liveCollectionNames())
  for (const id of await host.adapter.list(host.vault, HISTORY_COLLECTION)) {
    const parsed = parseHistoryId(id)
    if (parsed && !parsed.collection.startsWith('_')) names.add(parsed.collection)
  }
  return [...names].sort()
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export async function restoreTo(
  host: RestoreToHost,
  timestamp: string,
  options?: RestoreToOptions,
): Promise<RestoreToResult> {
  const dryRun = options?.dryRun === true
  const names = options?.collections ?? await candidateCollections(host)
  const per: Record<string, { written: string[]; deleted: string[]; unchanged: number }> = {}
  let written = 0, deleted = 0, unchanged = 0

  for (const name of names) {
    const past = host.instantCollection(name)
    const live = host.liveCollection(name)
    const atT = new Set(await past.list())
    const now = new Set((await host.adapter.list(host.vault, name)))
    const w: string[] = [], d: string[] = []
    let u = 0

    for (const id of atT) {
      const target = await past.get(id)
      if (target === null || target === undefined) continue
      const current = now.has(id) ? await live.get(id).catch(() => null) : null
      if (current !== null && same(current, target)) { u++; continue }
      if (!dryRun) await live.put(id, target)
      w.push(id)
    }
    for (const id of now) {
      if (atT.has(id)) continue
      const current = await live.get(id).catch(() => null)
      if (current === null) continue // already gone (tombstone / delete marker)
      if (!dryRun) await live.delete(id)
      d.push(id)
    }

    if (w.length || d.length || u) {
      per[name] = { written: w, deleted: d, unchanged: u }
      written += w.length; deleted += d.length; unchanged += u
    }
  }

  return { restoredTo: timestamp, dryRun, written, deleted, unchanged, collections: per }
}
