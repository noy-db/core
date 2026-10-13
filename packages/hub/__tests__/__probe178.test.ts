import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'

const SECRET = 'correct horse battery staple river stone'

describe('probe 178', () => {
  it('device 2 attaches its peer AFTER opening', async () => {
    const storeA = memoryStore()
    const dbA = await createNoydb({ store: storeA, user: 'alice', secret: SECRET, syncStrategy: withSync() })
    const vA = await dbA.openVault('acme')
    await vA.collection<{ id: string; n: number }>('rows').put('r1', { id: 'r1', n: 1 })

    // Device 2: a fresh local store, peer attached AFTER the open.
    const storeB = memoryStore()
    const dbB = await createNoydb({ store: storeB, user: 'alice', secret: SECRET, syncStrategy: withSync() })
    const vB = await dbB.openVault('acme')          // ← self-provisions here
    // ⚠️ THE DEVICE WRITES BEFORE IT ATTACHES — the reported symptom is "its
    // data is then unreadable everywhere", which needs data to exist.
    await vB.collection<{ id: string; n: number }>('rows').put('own', { id: 'own', n: 99 })
    await dbB.attachSyncTarget('acme', { store: storeA, role: 'sync-peer' })

    let read: unknown = 'n/a'
    let err: string | null = null
    try {
      await dbB.pull?.('acme')
      read = (await vB.collection<{ id: string; n: number }>('rows').get('r1'))?.n
    } catch (e) { err = `${(e as Error).name}: ${(e as Error).message.slice(0, 90)}` }
    let own: unknown = 'n/a'
    try { own = (await vB.collection<{ id: string; n: number }>('rows').get('own'))?.n }
    catch (e) { own = `THREW ${(e as Error).name}` }
    console.log('AFTER-ATTACH peer record:', read, '| own record:', own, '| err:', err)
    // And on device 1, after a push — is device 2's own record readable there?
    let onA: unknown = 'n/a'
    try { await dbB.push?.('acme'); onA = (await vA.collection<{ id: string; n: number }>('rows').get('own'))?.n }
    catch (e) { onA = `THREW ${(e as Error).name}` }
    console.log('device 2 record as seen on device 1:', onA)

    // The construction-time form, for contrast.
    const storeC = memoryStore()
    const dbC = await createNoydb({
      store: storeC, user: 'alice', secret: SECRET, syncStrategy: withSync(),
      sync: { store: storeA, role: 'sync-peer' },
    })
    const vC = await dbC.openVault('acme')
    let read2: unknown = 'n/a'
    try {
      await dbC.pull?.('acme')
      read2 = (await vC.collection<{ id: string; n: number }>('rows').get('r1'))?.n
    } catch (e) { read2 = `THREW ${(e as Error).name}` }
    console.log('CONSTRUCTION-TIME read:', read2)
    // Is the keyring file IDENTICAL across a legitimate pair? The refusal I
    // would build rests on that invariant.
    const kA = await storeA.get('acme', '_keyring', 'alice')
    const kB = await storeB.get('acme', '_keyring', 'alice')
    const kC = await storeC.get('acme', '_keyring', 'alice')
    console.log('keyring A===C (legit pair):', JSON.stringify(kA) === JSON.stringify(kC))
    console.log('keyring A===B (broken pair):', JSON.stringify(kA) === JSON.stringify(kB))
    expect(true).toBe(true)
  })
})
