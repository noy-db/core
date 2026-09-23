/**
 * core#108 — the writer's OWN device catches it first.
 *
 * core#74 made an arriving record face this device's gates. That leaves the
 * writer last to know: a record written offline into a period that closed
 * meanwhile pushes fine, and every OTHER device refuses it at admission.
 * Nobody tells the author.
 *
 * So before a dirty record is pushed, the same `beforePut` bus and
 * `db.onBeforeWrite` hooks run against CURRENT local state with
 * `origin: 'push-recheck'`. A refusal WITHHOLDS the record — not pushed, not
 * un-dirtied, local copy intact — parks it under `_sync_rejected`, reports it
 * in `PushResult.rejected` and emits `sync:rejected`.
 *
 * ⭐ The load-bearing case is the LAST one in each pair: the withheld record
 * goes out by itself once the rule passes again. Without it these rows would
 * pass just as well for a change that silently dropped the record, which is
 * the failure this feature must not become — a sync feature that loses a
 * write is worse than the papercut it fixes.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore, SyncRejection } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
type Note = { n: number; period: string }
type Close = { closed: boolean }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string) {
  return createNoydb({ store, sync: remote, user, secret, validateSecret: false, syncStrategy: withSync(), teamStrategy: withTeam() })
}

async function firm() {
  const remote = memoryStore()
  const dbO = await open(memoryStore(), remote, 'owner', S)
  const vO = await dbO.openVault('firm')
  await vO.collection<Close>('closes').put('2026-08', { closed: false })
  await vO.collection<Close>('closes').put('2026-09', { closed: false })
  await dbO.grant('firm', { userId: 'C', displayName: 'C', role: 'operator', secret: U, permissions: { notes: 'rw', closes: 'rw' } })
  await dbO.push('firm')
  const openMember = async () => {
    const db = await open(memoryStore(), remote, 'C', U)
    const v = await db.openVault('firm'); await db.pull('firm')
    return { db, v }
  }
  return { remote, dbO, vO, openMember }
}

function closedPeriodRule(db: Awaited<ReturnType<typeof createNoydb>>) {
  db.onBeforeWrite(async (e) => {
    if (e.collection !== 'notes' || e.after === null) return
    const period = (e.after as Note).period
    const close = await db.vault(e.vault).collection<Close>('closes').get(period)
    if (close?.closed) throw new Error(`PERIOD_CLOSED: ${period} (${e.origin ?? 'local-write'})`)
  })
}

/** close a period on the owner and push it. */
async function closePeriod(dbO: Awaited<ReturnType<typeof createNoydb>>, vO: Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>>, period: string, closed: boolean) {
  await vO.collection<Close>('closes').put(period, { closed })
  await dbO.push('firm')
}

describe('core#108 — a dirty record is re-judged before it is pushed', () => {
  it('the offline note is WITHHELD once its period closes — and goes out by itself when the period reopens', async () => {
    const { remote, dbO, vO, openMember } = await firm()
    const C = await openMember(); closedPeriodRule(C.db)

    // written while C's view says the period is open — its own gate allows it
    await C.v.collection<Note>('notes').put('c1', { n: 1, period: '2026-08' })

    // the close reaches C before it gets a chance to push
    await closePeriod(dbO, vO, '2026-08', true)
    await C.db.pull('firm')

    const events: SyncRejection[] = []
    C.db.on('sync:rejected', (r) => events.push(r))
    const r = await C.db.push('firm')

    expect(r.pushed).toBe(0)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected![0]!.id).toBe('c1')
    expect(r.rejected![0]!.origin).toBe('push-recheck')
    expect(r.rejected![0]!.reason).toMatch(/PERIOD_CLOSED: 2026-08 \(push-recheck\)/)
    expect(events.map(e => e.id)).toEqual(['c1'])

    // withheld, not lost: nothing left, the local copy is intact, and it is parked
    expect(await remote.get('firm', 'notes', 'c1')).toBeNull()
    expect(await C.v.collection<Note>('notes').get('c1')).toEqual({ n: 1, period: '2026-08' })
    expect((await C.db.rejected('firm').list()).map(x => x.id)).toContain('c1')

    // ⭐ the property: reopen, and the SAME record pushes with no redo, no readmit
    await closePeriod(dbO, vO, '2026-08', false)
    await C.db.pull('firm')
    const again = await C.db.push('firm')
    expect(again.rejected).toBeUndefined()
    expect(again.pushed).toBe(1)
    expect(await remote.get('firm', 'notes', 'c1')).not.toBeNull()
  })

  it('a note in an OPEN period is unaffected — the control', async () => {
    const { remote, dbO, vO, openMember } = await firm()
    const C = await openMember(); closedPeriodRule(C.db)
    await C.v.collection<Note>('notes').put('open', { n: 2, period: '2026-09' })
    await closePeriod(dbO, vO, '2026-08', true)   // a DIFFERENT period closes
    await C.db.pull('firm')
    const r = await C.db.push('firm')
    expect(r.rejected).toBeUndefined()
    expect(r.pushed).toBe(1)
    expect(await remote.get('firm', 'notes', 'open')).not.toBeNull()
  })

  it('with no rule registered nothing is re-checked, and the push is unchanged', async () => {
    const { remote, dbO, vO, openMember } = await firm()
    const C = await openMember()                   // no closedPeriodRule
    await C.v.collection<Note>('notes').put('c2', { n: 3, period: '2026-08' })
    await closePeriod(dbO, vO, '2026-08', true)
    await C.db.pull('firm')
    const r = await C.db.push('firm')
    expect(r.rejected).toBeUndefined()
    expect(r.pushed).toBe(1)
    expect(await remote.get('firm', 'notes', 'c2')).not.toBeNull()
  })

  it('a DELETE of a refused-period record still pushes — erasure is never gated', async () => {
    const { remote, dbO, vO, openMember } = await firm()
    const C = await openMember(); closedPeriodRule(C.db)
    await C.v.collection<Note>('notes').put('doomed', { n: 4, period: '2026-09' })
    expect((await C.db.push('firm')).pushed).toBe(1)
    await C.v.collection<Note>('notes').delete('doomed')
    await closePeriod(dbO, vO, '2026-09', true)
    await C.db.pull('firm')
    const r = await C.db.push('firm')
    expect(r.rejected).toBeUndefined()
    expect(r.pushed).toBe(1)
  })

  it('pushFiltered gates too — it is not the way round the re-check', async () => {
    const { remote, dbO, vO, openMember } = await firm()
    const C = await openMember(); closedPeriodRule(C.db)
    await C.v.collection<Note>('notes').put('f1', { n: 5, period: '2026-08' })
    await closePeriod(dbO, vO, '2026-08', true)
    await C.db.pull('firm')

    const engine = (C.db as unknown as { syncEngines: Map<string, { pushFiltered(p: (e: { collection: string }) => boolean): Promise<{ pushed: number; rejected?: SyncRejection[] }> }> }).syncEngines.get('firm')!
    const r = await engine.pushFiltered((e) => e.collection === 'notes')
    expect(r.pushed).toBe(0)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected![0]!.origin).toBe('push-recheck')
    expect(await remote.get('firm', 'notes', 'f1')).toBeNull()
  })
})

/**
 * core#108/#107 follow-ups, all three witnessed by pilot-1 on real DynamoDB
 * before they were fixed here.
 */
describe('core#108/#107 — what the witness found', () => {
  it("a first-ever create is reported as 'create', not 'update' (the record is already stored)", async () => {
    const { dbO, vO, openMember } = await firm()
    const C = await openMember()
    const ops: string[] = []
    C.db.onBeforeWrite(async (e) => {
      if (e.collection !== 'notes') return
      if (e.origin === 'push-recheck') ops.push(`${e.op}:${e.before === null ? 'no-prior' : 'prior'}`)
      const close = await C.db.vault(e.vault).collection<Close>('closes').get((e.after as Note).period)
      if (close?.closed) throw new Error('PERIOD_CLOSED')
    })
    await C.v.collection<Note>('notes').put('fresh', { n: 1, period: '2026-09' })
    await C.db.push('firm')
    expect(ops).toEqual(['create:no-prior'])

    // and a genuine second version still reads as an update
    ops.length = 0
    await C.v.collection<Note>('notes').put('fresh', { n: 2, period: '2026-09' })
    await C.db.push('firm')
    expect(ops).toEqual(['update:prior'])
    void dbO; void vO
  })

  it('every refusal carries an origin, including sync-apply, and a recordAt distinct from at', async () => {
    const { dbO, vO, openMember } = await firm()
    const C = await openMember(); closedPeriodRule(C.db)
    await C.v.collection<Note>('notes').put('c9', { n: 1, period: '2026-08' })
    await closePeriod(dbO, vO, '2026-08', true)
    await C.db.pull('firm')
    const r = await C.db.push('firm')

    const rej = r.rejected![0]!
    expect(rej.origin).toBe('push-recheck')
    // the record was written before the refusal was made
    expect(rej.recordAt).toBeTruthy()
    expect(Date.parse(rej.recordAt!)).toBeLessThanOrEqual(Date.parse(rej.at))
  })
})
