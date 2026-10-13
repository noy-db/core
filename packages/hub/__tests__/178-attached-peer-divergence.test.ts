/**
 * family#178 — a device that attaches its peer AFTER opening diverges silently.
 *
 * ⛔ WHAT I MEASURED, two devices, same user, same secret, device 2 on a fresh
 * local store:
 *     peer record on device 2:            undefined
 *     device 2's OWN record:              99
 *     device 2's record seen on device 1: undefined
 * Each device read only its own records, under two different keyrings, with NO
 * error anywhere. `openVault` found no `_keyring`, self-provisioned a brand-new
 * owner keyring, and the two lineages never reconciled.
 *
 * ⭐ THE TRIGGER IS A LOCAL WRITE BEFORE THE ATTACH. With no local write the
 * reserved-keyring mirror adopts the peer's keyring on the first pull and
 * everything works. Once the device has written under its self-provisioned
 * keyring the mirror will not supersede it, and the divergence sticks. The
 * no-write case below is therefore NOT a control — it passed before the fix and
 * passes after, and counting it as coverage is the mistake this note exists to
 * prevent.
 *
 * ⛔ WHY THE GUARD IS AT ATTACH AND NOT AT FIRST KEYRING ACCESS. It cannot be
 * there: `vault()` throws unless the vault is already open, so
 * `attachSyncTarget` necessarily runs AFTER `openVault` — and `openVault` is
 * where the self-provision happens. At that moment no peer is attached and none
 * can be consulted.
 *
 * ⚠️ IT REFUSES RATHER THAN REPAIRING. Adopting the peer's keyring would discard
 * the local one, and every record this device already wrote is sealed under the
 * discarded DEKs — a "repair" that trades a visible divergence for silent data
 * loss.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import type { NoydbStore } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'

const SECRET = 'correct horse battery staple river stone'

const open = async (store: NoydbStore) => await createNoydb({
  store, user: 'alice', secret: SECRET, syncStrategy: withSync(),
})

/** Device 1, holding one record. */
async function deviceOne(): Promise<{ store: NoydbStore }> {
  const store = memoryStore()
  const db = await open(store)
  const v = await db.openVault('acme')
  await v.collection<{ id: string; n: number }>('rows').put('r1', { id: 'r1', n: 1 })
  await db.close()
  return { store }
}

describe('family#178 — attaching a peer after opening', () => {
  it('⭐ THROWS when this device has already written under its own keyring', async () => {
    // THE CONTROL. openVault → put → attachSyncTarget, which is the sequence a
    // consumer was about to ship.
    const { store: storeA } = await deviceOne()
    const dbB = await open(memoryStore())
    const vB = await dbB.openVault('acme')              // self-provisions here
    await vB.collection<{ id: string; n: number }>('rows').put('own', { id: 'own', n: 99 })

    await expect(
      dbB.attachSyncTarget('acme', { store: storeA, role: 'sync-peer' }),
      'the attach was accepted and the two devices diverged silently',
    ).rejects.toThrow(/DIFFERENT keyring/)
    await dbB.close()
  })

  it('the refusal names both supported paths, so the caller can act', async () => {
    // A refusal a consumer cannot act on would send them to the source. Both
    // remedies are real: pass the peer at construction, or start from empty.
    const { store: storeA } = await deviceOne()
    const dbB = await open(memoryStore())
    const vB = await dbB.openVault('acme')
    await vB.collection<{ id: string }>('rows').put('own', { id: 'own' })

    const err = await dbB.attachSyncTarget('acme', { store: storeA, role: 'sync-peer' })
      .then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/createNoydb\(\{ sync:/)
    expect(err?.message).toMatch(/empty local store/)
    await dbB.close()
  })

  it('⭐ the SUPPORTED path still works — peer at construction, both records readable', async () => {
    // The positive half. Without it, a guard that refused every attach would
    // satisfy the cases above while breaking multi-device sync outright.
    const { store: storeA } = await deviceOne()
    const dbC = await createNoydb({
      store: memoryStore(), user: 'alice', secret: SECRET, syncStrategy: withSync(),
      sync: { store: storeA, role: 'sync-peer' },
    })
    const vC = await dbC.openVault('acme')
    await dbC.pull?.('acme')
    expect((await vC.collection<{ id: string; n: number }>('rows').get('r1'))?.n).toBe(1)
    await dbC.close()
  })

  it('attaching a SECOND peer to an already-converged device is still allowed', async () => {
    // The guard must not refuse a legitimate attach on a device whose keyring
    // already matches — which is every device that bootstrapped correctly.
    const { store: storeA } = await deviceOne()
    const dbC = await createNoydb({
      store: memoryStore(), user: 'alice', secret: SECRET, syncStrategy: withSync(),
      sync: { store: storeA, role: 'sync-peer' },
    })
    await dbC.openVault('acme')
    await dbC.pull?.('acme')
    await expect(dbC.attachSyncTarget('acme', { store: storeA, role: 'sync-peer' })).resolves.toBeUndefined()
    await dbC.close()
  })

  it('⚠️ NOT A CONTROL: with no local write the attach is accepted', async () => {
    // Recorded because it passed BEFORE the fix and passes after. The
    // reserved-keyring mirror adopts the peer's keyring on the first pull, so
    // nothing has diverged yet and there is nothing to refuse. A two-device test
    // written without the local write would have proved nothing — and would have
    // looked exactly like coverage.
    const { store: storeA } = await deviceOne()
    const dbB = await open(memoryStore())
    await dbB.openVault('acme')
    await expect(dbB.attachSyncTarget('acme', { store: storeA, role: 'sync-peer' })).resolves.toBeUndefined()
    await dbB.close()
  })
})
