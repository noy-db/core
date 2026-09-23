/**
 * core#111 — restoring an OLDER pod onto a store whose ledger moved on.
 *
 * `loadVault` replaced the DATA collections wholesale (`saveAll`) and then put
 * the pod's `_ledger` entries id by id, leaving every entry written AFTER the
 * pod in place. With history on, the chain the integrity check walks then
 * named a record the restore had just removed:
 *
 *   BackupCorruptedError: Ledger expects data record "notes/n2" to exist,
 *   but the adapter has no envelope for it.
 *
 * ⭐ So a restore worked only onto a store whose ledger had not moved since
 * the pod — which is never the case that matters. A restore is a step BACK
 * (core#71/#72); "nothing has happened since" describes a store that does not
 * need restoring.
 *
 * A restore now rewinds the ledger too: the internal collections are replaced
 * wholesale, the way `saveAll` already treats the data ones.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
interface Note { id: string; body: string }

function open(store: NoydbStore, extra: Record<string, unknown> = {}) {
  return createNoydb({
    store, user: 'owner', secret: S, validateSecret: false,
    historyStrategy: withHistory(), ...extra,
  })
}

describe('core#111 — an older pod restores onto a store that moved on', () => {
  it('the exact filed sequence: write n1, dump, write n2, load — no BackupCorruptedError', async () => {
    const store = memoryStore()
    const db = await open(store)
    const v = await db.openVault('v1')
    const notes = v.collection<Note>('notes')

    await notes.put('n1', { id: 'n1', body: 'one' })
    const pod = await v.dump()

    await notes.put('n2', { id: 'n2', body: 'two' })          // the ledger moves past the pod
    expect(await notes.get('n2')).not.toBeNull()

    await v.load(pod)                                          // used to throw

    // the pod's state is what is here, and n2 is gone from data AND from the chain
    // core#122 — the handle captured BEFORE the load answers correctly too.
    // It used to keep its own cache and serve the pre-restore record, because
    // `clearCollectionCache()` dropped the vault's map of instances rather
    // than invalidating them; the handle a caller already held was one of
    // those objects. Asserted through the stale handle AND the store, so a
    // regression shows up here rather than in a consumer's restore path.
    expect(await store.get('v1', 'notes', 'n2')).toBeNull()
    expect(await notes.get('n2')).toBeNull()                       // the captured handle (core#122)
    expect(await v.collection<Note>('notes').get('n2')).toBeNull() // and a fresh one
    // ⚠️ NOT `get('_ledger', 'n2')`: ledger ids are chain INDICES
    // (`0000000000`), never record ids, so that assertion is null whatever
    // happens. It was in this file until core#77's test caught it by asserting
    // the positive case first. Count the chain instead.
    expect(await store.list('v1', '_ledger')).toHaveLength(1)
    expect(await notes.get('n1')).toEqual({ id: 'n1', body: 'one' })

    // ⭐ the control: the restored vault is USABLE, not merely un-thrown. A
    // clear step that wiped the chain instead of rewinding it would also pass
    // every assertion above.
    const fresh = v.collection<Note>('notes')
    await fresh.put('n3', { id: 'n3', body: 'three' })
    expect(await fresh.get('n3')).toEqual({ id: 'n3', body: 'three' })
    const again = await v.dump()
    await v.load(again)
    expect(await v.collection<Note>('notes').get('n3')).toEqual({ id: 'n3', body: 'three' })
  })

  it('internal rows absent from the pod because they were EMPTY at dump time are cleared too', async () => {
    // The dump skips an internal collection with no rows, so the pod never
    // mentions `_periods`. Clearing only what the pod carries would keep a
    // period closed after restoring a pod taken before it was closed — the
    // write gate surviving a restore that was meant to precede it.
    const store = memoryStore()
    const db = await open(store, { periodsStrategy: withPeriods() })
    const v = await db.openVault('v1')
    await v.collection<Note>('notes').put('n1', { id: 'n1', body: 'one' })

    const pod = await v.dump()                                 // taken with no periods
    await v.closePeriod({ name: '2026-08', endDate: '2026-08-31', dateField: 'asOf' })
    expect((await store.list('v1', '_periods')).length).toBeGreaterThan(0)

    await v.load(pod)
    expect(await store.list('v1', '_periods')).toEqual([])
  })
})
